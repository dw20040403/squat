// セッション一覧画面（spec 5.8）：日時、長さ、中止の有無。再生・ダウンロード・削除
import { ABORT_MESSAGES } from '../monitor/anomaly';
import {
  deleteRemoteSession,
  listRemoteSessions,
  loadRemoteSession,
  loadRemoteVideo,
  uploadSession,
} from '../record/remote';
import {
  deleteSession,
  listSessions,
  loadSession,
  loadVideo,
  storageStatus,
  type SessionMeta,
} from '../record/store';
import { sessionToCsv, type Session } from '../record/session';
import { downloadBlob, downloadJson, downloadText, videoExt } from '../util/download';
import { clear, fmtDate, h, openSheet, toast } from './dom';
import { Player, type PlayerOptions } from './playback';

export function exportSession(s: Session, kind: 'json' | 'csv'): void {
  if (kind === 'json') downloadJson(s, `session-${s.id}.json`);
  else downloadText(sessionToCsv(s), `session-${s.id}-metrics.csv`, 'text/csv');
}

export function openPlayback(
  s: Session,
  video: Blob | null,
  minVisibility: number,
  opts: PlayerOptions = {},
): void {
  openSheet(`再生 ${s.id}`, (body, sheet) => {
    const p = new Player(s, video, minVisibility, opts);
    body.appendChild(p.el);
    body.appendChild(
      h(
        'div',
        { class: 'row', style: 'margin-top:8px' },
        h('button', { class: 'btn small', onclick: () => exportSession(s, 'json') }, 'JSON'),
        h('button', { class: 'btn small', onclick: () => exportSession(s, 'csv') }, 'CSV'),
        video
          ? h(
              'button',
              {
                class: 'btn small',
                onclick: () => downloadBlob(video, `session-${s.id}-main.${videoExt(video.type)}`),
              },
              '映像',
            )
          : null,
      ),
    );
    sheet.onClose = () => p.dispose();
  });
}

/** セッションの置き場所（主端末のIndexedDB、またはサーバー） */
export interface SessionSource {
  list(): Promise<SessionMeta[]>;
  load(id: string): Promise<Session | null>;
  loadVideo(id: string): Promise<Blob | null>;
  remove(id: string): Promise<void>;
  /** 一覧の上に出す説明 */
  status(): Promise<string>;
  /** 再生画面の設定 */
  player?: PlayerOptions;
  /** 行ごとに追加するボタン */
  extraButtons?(m: SessionMeta): HTMLElement[];
}

/** 主端末のIndexedDB */
export const localSource: SessionSource = {
  list: listSessions,
  load: loadSession,
  loadVideo,
  remove: deleteSession,
  async status() {
    const s = await storageStatus();
    return `保存容量：${s.usage !== null ? (s.usage / 1e6).toFixed(0) : '?'}MB / ${s.quota !== null ? (s.quota / 1e6).toFixed(0) : '?'}MB、${s.persisted ? '自動で消されない設定（persist）が有効' : 'Safariが保存データを自動で消すことがあります。必要なデータはダウンロードしてください'}`;
  },
  extraButtons: (m) => [
    h(
      'button',
      {
        class: 'btn small',
        onclick: async (e: Event) => {
          const btn = e.currentTarget as HTMLButtonElement;
          btn.disabled = true;
          try {
            await sendToServer(m.id);
            toast('PCに送りました');
          } catch (err) {
            toast((err as Error).message, 4000);
          } finally {
            btn.disabled = false;
          }
        },
      },
      'PCへ送る',
    ),
  ],
};

/** サーバー（PC）に保存したセッション */
export const remoteSource: SessionSource = {
  list: listRemoteSessions,
  load: loadRemoteSession,
  loadVideo: loadRemoteVideo,
  remove: deleteRemoteSession,
  player: { panelBeside: true },
  async status() {
    return '主端末で測定を終えると、記録（主端末に表示していた骨格・指標）と映像が自動でここに送られます。届かなかった記録は、主端末の「セッション一覧」の「PCへ送る」で送り直せます。';
  },
};

/** 主端末に保存した記録をサーバーに送る */
export async function sendToServer(id: string): Promise<void> {
  const s = await loadSession(id);
  if (!s) throw new Error('記録を読み込めませんでした');
  await uploadSession(s, await loadVideo(id));
}

export function openSessions(minVisibility: number): void {
  openSheet('セッション一覧', (body) => void renderSessionList(body, minVisibility, localSource));
}

export async function renderSessionList(
  body: HTMLElement,
  minVisibility: number,
  src: SessionSource,
): Promise<() => Promise<void>> {
  const st = h('p', { class: 'note' }, '');
  const list = h('div', {});
  body.append(st, list);
  const refresh = async () => {
    st.textContent = await src.status();
    clear(list);
    let items: SessionMeta[];
    try {
      items = await src.list();
    } catch (e) {
      list.appendChild(h('div', { class: 'errbox' }, (e as Error).message));
      return;
    }
    if (!items.length) list.appendChild(h('p', { class: 'note' }, 'まだ記録がありません'));
    const tbl = h('table', {});
    for (const m of items) {
      const dur = m.endedAt
        ? ((m.endedAt - m.startedAt) / 1000).toFixed(1) + '秒'
        : '（記録中または異常終了）';
      tbl.appendChild(
        h(
          'tr',
          {},
          h(
            'td',
            {},
            h('div', {}, fmtDate(m.startedAt)),
            h(
              'div',
              { class: 'note' },
              `${m.id} ・ ${dur} ・ ${m.frameCount}フレーム ・ ${m.source === 'offline' ? 'オフライン' : 'リアルタイム'}${m.subjectId ? ` ・ ${m.subjectId}` : ''}${m.trialLabel ? ` ・ ${m.trialLabel}` : ''}`,
            ),
            m.aborted
              ? h(
                  'div',
                  { style: 'color:#ef4444;font-size:12px' },
                  `中止：${ABORT_MESSAGES[m.aborted.reason] ?? m.aborted.reason}`,
                )
              : null,
          ),
          h(
            'td',
            {},
            h(
              'div',
              { class: 'row' },
              h(
                'button',
                {
                  class: 'btn small primary',
                  onclick: async () => {
                    try {
                      const s = await src.load(m.id);
                      if (!s) return toast('読み込めませんでした');
                      openPlayback(
                        s,
                        m.hasVideo ? await src.loadVideo(m.id) : null,
                        minVisibility,
                        src.player,
                      );
                    } catch (e) {
                      toast((e as Error).message, 4000);
                    }
                  },
                },
                '再生',
              ),
              h(
                'button',
                {
                  class: 'btn small',
                  onclick: async () => {
                    const s = await src.load(m.id).catch(() => null);
                    if (s) exportSession(s, 'json');
                  },
                },
                'JSON',
              ),
              h(
                'button',
                {
                  class: 'btn small',
                  onclick: async () => {
                    const s = await src.load(m.id).catch(() => null);
                    if (s) exportSession(s, 'csv');
                  },
                },
                'CSV',
              ),
              m.hasVideo
                ? h(
                    'button',
                    {
                      class: 'btn small',
                      onclick: async () => {
                        const v = await src.loadVideo(m.id).catch(() => null);
                        if (v) downloadBlob(v, `session-${m.id}-main.${videoExt(v.type)}`);
                      },
                    },
                    '映像',
                  )
                : null,
              ...(src.extraButtons?.(m) ?? []),
              h(
                'button',
                {
                  class: 'btn small ghost',
                  onclick: async () => {
                    if (!confirm(`セッション ${m.id} を削除しますか？（元に戻せません）`)) return;
                    try {
                      await src.remove(m.id);
                    } catch (e) {
                      toast((e as Error).message, 4000);
                    }
                    await refresh();
                  },
                },
                '削除',
              ),
            ),
          ),
        ),
      );
    }
    list.appendChild(tbl);
  };
  await refresh();
  return refresh;
}
