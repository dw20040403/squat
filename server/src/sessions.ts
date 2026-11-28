// 主端末で記録したセッションの保存と配信（PCで記録を見るため）
//   recordings/sessions/<id>/session.json  セッション（主端末に表示していた2D骨格・3D関節・指標）
//   recordings/sessions/<id>/meta.json     一覧用の要約
//   recordings/sessions/<id>/video.<ext>   主カメラの録画

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_JSON = 512 * 1024 * 1024;
const MAX_VIDEO = 4 * 1024 * 1024 * 1024;
const VIDEO_EXTS = ['mp4', 'webm', 'bin'] as const;
const VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  bin: 'application/octet-stream',
};

export interface ServerSessionMeta {
  id: string;
  startedAt: number;
  endedAt: number | null;
  aborted: unknown;
  frameCount: number;
  hasVideo: boolean;
  source: string;
  subjectId?: string;
  trialLabel?: string;
  uploadedAt: number;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(JSON.stringify(body));
}

function videoExtOf(mime: string): (typeof VIDEO_EXTS)[number] {
  return mime.includes('mp4') ? 'mp4' : mime.includes('webm') ? 'webm' : 'bin';
}

function findVideo(dir: string): string | null {
  for (const e of VIDEO_EXTS) {
    const f = join(dir, `video.${e}`);
    if (existsSync(f)) return f;
  }
  return null;
}

/** リクエストの本文を一時ファイルに書き、上限を超えたら中断する */
async function receive(req: IncomingMessage, file: string, max: number): Promise<number> {
  const len = Number(req.headers['content-length'] ?? 0);
  if (len > max) throw Object.assign(new Error('too-large'), { status: 413 });
  let size = 0;
  req.on('data', (c: Buffer) => {
    size += c.length;
    if (size > max) req.destroy(Object.assign(new Error('too-large'), { status: 413 }));
  });
  const tmp = `${file}.part`;
  try {
    await pipeline(req, createWriteStream(tmp));
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  renameSync(tmp, file);
  return size;
}

/** 受け付けなかった本文を消す。ほかに何もなければフォルダも消す */
function discard(dir: string, tmp: string): void {
  rmSync(tmp, { force: true });
  if (existsSync(dir) && !readdirSync(dir).length) rmSync(dir, { recursive: true, force: true });
}

function readMeta(dir: string): ServerSessionMeta | null {
  try {
    const m = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as ServerSessionMeta;
    m.hasVideo = !!findVideo(dir);
    return m;
  } catch {
    return null;
  }
}

/** 映像の配信（Rangeに対応する。Safariはシークに必要） */
function sendVideo(req: IncomingMessage, res: ServerResponse, file: string): void {
  const size = statSync(file).size;
  const type = VIDEO_MIME[file.slice(file.lastIndexOf('.') + 1)] ?? 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start);
    end = Math.min(size - 1, end);
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': end - start + 1,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache',
    });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': size,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  });
  createReadStream(file).pipe(res);
}

/**
 * /api/sessions のハンドラ。扱ったらtrueを返す
 *   GET    /api/sessions             一覧（新しい順）
 *   PUT    /api/sessions/<id>        セッションのJSONを保存
 *   GET    /api/sessions/<id>        セッションのJSON
 *   DELETE /api/sessions/<id>        削除
 *   PUT    /api/sessions/<id>/video  映像を保存（Content-Typeで拡張子を決める）
 *   GET    /api/sessions/<id>/video  映像
 */
export function createSessionsHandler(baseDir: string) {
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = new URL(req.url ?? '/', 'http://x');
    const m = /^\/api\/sessions(?:\/([^/]+)(\/video)?)?\/?$/.exec(url.pathname);
    if (!m) return false;
    const [, id, isVideo] = m;
    const method = req.method ?? 'GET';
    void (async () => {
      try {
        if (!id) {
          if (method !== 'GET') return json(res, 405, { error: 'method' });
          const items = existsSync(baseDir)
            ? readdirSync(baseDir)
                .filter((d) => ID_RE.test(d))
                .map((d) => readMeta(join(baseDir, d)))
                .filter((x): x is ServerSessionMeta => !!x)
                .sort((a, b) => b.startedAt - a.startedAt)
            : [];
          return json(res, 200, items);
        }
        if (!ID_RE.test(id)) return json(res, 400, { error: 'bad-id' });
        const dir = join(baseDir, id);

        if (isVideo) {
          if (method === 'GET') {
            const f = findVideo(dir);
            if (!f) return json(res, 404, { error: 'not-found' });
            return sendVideo(req, res, f);
          }
          if (method !== 'PUT') return json(res, 405, { error: 'method' });
          mkdirSync(dir, { recursive: true });
          const ext = videoExtOf(String(req.headers['content-type'] ?? ''));
          for (const e of VIDEO_EXTS) if (e !== ext) rmSync(join(dir, `video.${e}`), { force: true });
          const size = await receive(req, join(dir, `video.${ext}`), MAX_VIDEO);
          return json(res, 200, { ok: true, size });
        }

        if (method === 'GET') {
          const f = join(dir, 'session.json');
          if (!existsSync(f)) return json(res, 404, { error: 'not-found' });
          res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': statSync(f).size,
            'Cache-Control': 'no-cache',
          });
          createReadStream(f).pipe(res);
          return;
        }
        if (method === 'DELETE') {
          rmSync(dir, { recursive: true, force: true });
          return json(res, 200, { ok: true });
        }
        if (method !== 'PUT') return json(res, 405, { error: 'method' });
        mkdirSync(dir, { recursive: true });
        const tmp = join(dir, 'upload.json');
        await receive(req, tmp, MAX_JSON);
        let s: Record<string, unknown>;
        try {
          s = JSON.parse(readFileSync(tmp, 'utf8'));
        } catch {
          discard(dir, tmp);
          return json(res, 400, { error: 'bad-json' });
        }
        if (s.version !== 1 || s.id !== id || !Array.isArray(s.frames) || !s.devices) {
          discard(dir, tmp);
          return json(res, 400, { error: 'not-session' });
        }
        renameSync(tmp, join(dir, 'session.json'));
        const subject = s.subject as { id?: string } | undefined;
        const trial = s.trial as { label?: string } | undefined;
        const meta: ServerSessionMeta = {
          id,
          startedAt: Number(s.startedAt),
          endedAt: (s.endedAt as number | null) ?? null,
          aborted: s.aborted ?? null,
          frameCount: (s.frames as unknown[]).length,
          hasVideo: !!findVideo(dir),
          source: String(s.source ?? 'realtime'),
          subjectId: subject?.id || undefined,
          trialLabel: trial?.label || undefined,
          uploadedAt: Date.now(),
        };
        writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
        return json(res, 200, { ok: true });
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        if (!res.headersSent) json(res, status, { error: (e as Error).message });
        else res.destroy();
      }
    })();
    return true;
  };
}
