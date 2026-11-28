// PCで記録を見る画面（sessions.html）。主端末が測定のあとに送った記録と映像を、主端末のセッション一覧と同じように再生する
import '../styles.css';
import { loadConfig } from '../configLoader';
import { h } from './dom';
import { remoteSource, renderSessionList } from './sessionsScreen';

async function boot(): Promise<void> {
  const root = document.getElementById('app')!;
  let minVisibility = 0.5;
  try {
    minVisibility = (await loadConfig()).params.fusion.minVisibility;
  } catch {
    /* 既定値で表示する */
  }
  const list = h('div', {});
  let refresh: (() => Promise<void>) | null = null;
  const page = h(
    'div',
    { style: 'max-width:960px;margin:0 auto;padding:12px' },
    h(
      'div',
      { class: 'row', style: 'justify-content:space-between;align-items:center' },
      h('h1', { style: 'font-size:20px' }, '記録の確認（PC）'),
      h('button', { class: 'btn small', onclick: () => void refresh?.() }, '更新'),
    ),
    list,
  );
  root.appendChild(page);
  refresh = await renderSessionList(list, minVisibility, remoteSource);
  // 主端末から新しい記録が届いたら一覧に出るように、画面に戻ったときに読み直す
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !document.querySelector('.sheet')) void refresh?.();
  });
}

void boot();
