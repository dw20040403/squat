// 設定画面：deviceNameの選択（localStorageに保存）、推論・検出の方式、主端末の記録の設定
import { listIntrinsics } from '../configLoader';
import { KEYS, loadJson, saveJson } from '../util/storage';
import type { DeviceCore } from './device';
import { clear, h, labeled, openSheet, toast } from './dom';

export interface SubjectInfo {
  id: string;
  heightM: number | null;
  note: string;
  trialLabel: string;
}

export const loadSubject = (): SubjectInfo =>
  loadJson<SubjectInfo>(KEYS.subject, { id: 'S01', heightM: null, note: '', trialLabel: 'normal' });

export function openSettings(core: DeviceCore, opts: { main: boolean; onChanged?: () => void }): void {
  openSheet('設定', async (body) => {
    body.appendChild(h('p', { class: 'note' }, '読み込み中…'));
    const list = await listIntrinsics();
    clear(body);

    // deviceName
    const sel = h('select', {});
    const names = [
      ...new Set([core.deviceName, ...list.map((x) => x.deviceName), 'iphone12', 'iphone11']),
    ];
    for (const n of names) {
      const it = list.find((x) => x.deviceName === n);
      const label = it
        ? `${n}${it.approximate ? '（仮の値）' : ''}${it.imageSize ? ` ${it.imageSize[0]}×${it.imageSize[1]}` : ''}${it.rms ? ` RMS ${it.rms.toFixed(2)}px` : ''}`
        : `${n}（内部パラメータなし）`;
      sel.appendChild(h('option', { value: n, selected: n === core.deviceName }, label));
    }
    const intrStatus = h('div', {});
    const showIntr = () => {
      clear(intrStatus);
      if (!core.intr)
        intrStatus.appendChild(
          h(
            'div',
            { class: 'errbox' },
            `内部パラメータ config/intrinsics/${core.deviceName}.json がありません。校正画像を撮影し、tools/calibrate_intrinsics.py で作成してください。`,
          ),
        );
      else {
        const i = core.intr;
        intrStatus.appendChild(
          h(
            'div',
            { class: core.resolutionOk ? 'okbox' : 'warnbox' },
            `fx ${i.K.fx.toFixed(1)} fy ${i.K.fy.toFixed(1)} cx ${i.K.cx.toFixed(1)} cy ${i.K.cy.toFixed(1)} ／ 校正時 ${i.imageSize[0]}×${i.imageSize[1]} ／ 現在の映像 ${core.cam?.width ?? '?'}×${core.cam?.height ?? '?'}`,
            core.resolutionOk ? '' : ' → 解像度が一致しません（測定を開始できません）',
            i.approximate ? ' ※仮の値です' : '',
          ),
        );
      }
    };
    sel.addEventListener('change', async () => {
      await core.setDeviceName(sel.value);
      showIntr();
      opts.onChanged?.();
      toast(`deviceName を ${sel.value} にしました`);
    });
    body.append(h('h3', {}, 'この端末'), labeled('deviceName（内部パラメータの名前）', sel), intrStatus);
    const custom = h('input', { placeholder: '新しい名前（例：iphone13）' });
    body.appendChild(
      h(
        'div',
        { class: 'row' },
        custom,
        h(
          'button',
          {
            class: 'btn small',
            onclick: async () => {
              const v = custom.value.trim();
              if (!/^[\w.-]+$/.test(v)) return toast('英数字と - _ . だけ使えます');
              sel.appendChild(h('option', { value: v, selected: true }, v));
              sel.value = v;
              sel.dispatchEvent(new Event('change'));
            },
          },
          '追加',
        ),
      ),
    );
    showIntr();

    // 推論と検出
    body.appendChild(h('h3', {}, '処理の方式'));
    const del = h(
      'select',
      {},
      ...['auto', 'GPU', 'CPU'].map((d) =>
        h(
          'option',
          { value: d, selected: loadJson(KEYS.delegate, 'auto') === d },
          d === 'auto' ? '自動（GPU→CPU）' : d,
        ),
      ),
    );
    del.addEventListener(
      'change',
      () => (saveJson(KEYS.delegate, del.value), toast('次回の起動から反映します')),
    );
    body.appendChild(
      labeled(
        `姿勢推定のデリゲート（現在：${core.est?.delegate ?? '—'}、モデル：${core.cfg.params.poseModel}）`,
        del,
      ),
    );
    const det = h(
      'select',
      {},
      ...[
        ['auto', '自動（OpenCV.js→js-aruco2）'],
        ['opencv', 'OpenCV.js'],
        ['js-aruco2', 'js-aruco2'],
      ].map(([v, l]) => h('option', { value: v, selected: loadJson(KEYS.arucoDetector, 'auto') === v }, l)),
    );
    det.addEventListener('change', () => saveJson(KEYS.arucoDetector, det.value));
    body.appendChild(labeled('ArUcoマーカーの検出', det));

    if (opts.main) {
      body.appendChild(h('h3', {}, '記録'));
      const rv = h('input', {
        type: 'checkbox',
        checked: loadJson(KEYS.recordVideo, core.cfg.params.recording.recordVideo),
      });
      rv.addEventListener('change', () => saveJson(KEYS.recordVideo, rv.checked));
      body.appendChild(h('label', { class: 'row' }, rv, '測定中に主カメラの映像を同時に録画する'));
      const cd = h('input', { type: 'number', min: 0, max: 30, value: loadJson(KEYS.countdown, 0) });
      cd.addEventListener('change', () =>
        saveJson(KEYS.countdown, Math.max(0, Math.min(30, Number(cd.value) || 0))),
      );
      body.appendChild(labeled('測定開始のカウントダウン（秒。立ち位置に戻る時間。0でなし）', cd));

      const s = loadSubject();
      const sid = h('input', { value: s.id });
      const sh = h('input', { type: 'number', step: 0.01, value: s.heightM ?? '', placeholder: '例：1.70' });
      const sn = h('input', { value: s.note });
      const tl = h(
        'select',
        {},
        ...[
          ['normal', '通常'],
          ['deep', '深い'],
          ['toe-out', 'つま先を開く'],
          ['knee-in', '膝を入れる'],
          ['other', 'その他'],
        ].map(([v, l]) => h('option', { value: v, selected: s.trialLabel === v }, l)),
      );
      const save = () =>
        saveJson(KEYS.subject, {
          id: sid.value.trim(),
          heightM: sh.value ? Number(sh.value) : null,
          note: sn.value,
          trialLabel: tl.value,
        });
      [sid, sh, sn, tl].forEach((x) => x.addEventListener('change', save));
      body.append(
        h('h3', {}, '被験者と試技（セッションに記録）'),
        labeled('被験者ID', sid),
        labeled('身長（m）', sh),
        labeled('試技の種類', tl),
        labeled('メモ', sn),
      );
    }

    // カメラの情報（plan フェーズ2 手順8の確認用）
    body.appendChild(h('h3', {}, 'カメラの情報'));
    const c = core.cam;
    body.appendChild(
      h(
        'pre',
        { class: 'code' },
        c
          ? [
              `選ばれたカメラ: ${c.label}`,
              `解像度: ${c.width}×${c.height}`,
              `captureTime: ${core.loop?.captureTimeAvailable === null ? '未確認' : core.loop?.captureTimeAvailable ? '取得できる' : '取得できない'}`,
              `設定: ${JSON.stringify(c.settings)}`,
              '映像入力の一覧:',
              ...c.devices.map(
                (d) => `  - ${d.label || '(ラベルなし)'} ${d.deviceId === c.deviceId ? '← 使用中' : ''}`,
              ),
            ].join('\n')
          : 'カメラが起動していません',
      ),
    );
  });
}
