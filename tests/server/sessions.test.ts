import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSessionsHandler } from '../../server/src/sessions';

let server: Server;
let dir: string;
let base: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'squat-sessions-'));
  const handle = createSessionsHandler(dir);
  server = createServer((req, res) => {
    if (!handle(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  base = `http://127.0.0.1:${addr.port}/api/sessions`;
});

afterAll(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const session = (id: string) => ({
  version: 1,
  id,
  source: 'realtime',
  startedAt: 1000,
  endedAt: 3000,
  aborted: null,
  subject: { id: 'S01', heightM: null, note: '' },
  trial: { label: 'T1' },
  devices: { main: {}, sub: {} },
  frames: [{ t: 1000 }, { t: 1033 }],
});

describe('セッションの保存API', () => {
  it('映像とJSONを保存し、一覧・取得・Range・削除ができる', async () => {
    const video = new Uint8Array(1000).map((_, i) => i % 256);
    let r = await fetch(`${base}/20260101-120000/video`, {
      method: 'PUT',
      headers: { 'Content-Type': 'video/mp4' },
      body: video,
    });
    expect(r.status).toBe(200);
    r = await fetch(`${base}/20260101-120000`, {
      method: 'PUT',
      body: JSON.stringify(session('20260101-120000')),
    });
    expect(r.status).toBe(200);

    const list = await (await fetch(base)).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: '20260101-120000',
      frameCount: 2,
      hasVideo: true,
      subjectId: 'S01',
      trialLabel: 'T1',
    });

    const s = await (await fetch(`${base}/20260101-120000`)).json();
    expect(s.frames).toHaveLength(2);

    const v = await fetch(`${base}/20260101-120000/video`);
    expect(v.headers.get('content-type')).toBe('video/mp4');
    expect(new Uint8Array(await v.arrayBuffer())).toEqual(video);

    const part = await fetch(`${base}/20260101-120000/video`, { headers: { Range: 'bytes=10-19' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 10-19/1000');
    expect(Array.from(new Uint8Array(await part.arrayBuffer()))).toEqual(Array.from(video.slice(10, 20)));

    r = await fetch(`${base}/20260101-120000`, { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(await (await fetch(base)).json()).toEqual([]);
  });

  it('セッション形式でないJSONやIDの不一致、不正なIDは受け付けない', async () => {
    let r = await fetch(`${base}/abc`, { method: 'PUT', body: '{"version":1}' });
    expect(r.status).toBe(400);
    r = await fetch(`${base}/abc`, { method: 'PUT', body: JSON.stringify(session('xyz')) });
    expect(r.status).toBe(400);
    r = await fetch(`${base}/abc`, { method: 'PUT', body: 'not json' });
    expect(r.status).toBe(400);
    r = await fetch(`${base}/..%2Fetc`);
    expect(r.status).toBe(400);
    expect(await (await fetch(base)).json()).toEqual([]);
  });
});
