// サーバー（PC）に保存したセッション。主端末は測定のあとに送り、PCの記録の確認画面（sessions.html）で見る
import type { Session } from './session';
import type { SessionMeta } from './store';

const base = (id: string) => `/api/sessions/${encodeURIComponent(id)}`;

async function check(res: Response, what: string): Promise<Response> {
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { error?: string }).error ?? '';
    } catch {
      /* 本文がJSONでない */
    }
    throw new Error(`${what}に失敗しました（${res.status}${detail ? ` ${detail}` : ''}）`);
  }
  return res;
}

/** セッションと映像をサーバーに送る。映像を先に送り、JSONが届いた時点で一覧に出る */
export async function uploadSession(s: Session, video: Blob | null): Promise<void> {
  if (video) {
    await check(
      await fetch(`${base(s.id)}/video`, {
        method: 'PUT',
        headers: { 'Content-Type': video.type || s.video?.mimeType || 'application/octet-stream' },
        body: video,
      }),
      '映像の送信',
    );
  }
  await check(
    await fetch(base(s.id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(s),
    }),
    '記録の送信',
  );
}

export async function listRemoteSessions(): Promise<SessionMeta[]> {
  const res = await check(await fetch('/api/sessions', { cache: 'no-cache' }), '一覧の読み込み');
  return (await res.json()) as SessionMeta[];
}

export async function loadRemoteSession(id: string): Promise<Session | null> {
  const res = await fetch(base(id), { cache: 'no-cache' });
  if (res.status === 404) return null;
  return (await (await check(res, '記録の読み込み')).json()) as Session;
}

export async function loadRemoteVideo(id: string): Promise<Blob | null> {
  const res = await fetch(`${base(id)}/video`, { cache: 'no-cache' });
  if (res.status === 404) return null;
  return (await check(res, '映像の読み込み')).blob();
}

export async function deleteRemoteSession(id: string): Promise<void> {
  await check(await fetch(base(id), { method: 'DELETE' }), '削除');
}
