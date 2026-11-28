// 測定の開始 → 測定停止 → 記録の保存（偽のカメラには人が映っていないが、可視度の条件では中止しない）
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { lookAtCamera } from '../synthetic/generator';
import { measuredLayout } from '../../web/src/calib/layout';

const HERE = dirname(fileURLToPath(import.meta.url));
const INTR_FILE = resolve(HERE, '../../config/intrinsics/_e2e-fake-front.json');
// 端末の名前。内部パラメータの名前はカメラの向き（既定は内カメ＝front）を付けたもの
const BASE = '_e2e-fake';
const NAME = `${BASE}-front`;

test.afterAll(() => rmSync(INTR_FILE, { force: true }));

test('測定を開始し、人が映っていなくても中止されず、測定停止で記録が保存される', async ({ browser }) => {
  // 偽のカメラは横長1280×720なので、それに合わせた仮の内部パラメータを置く
  const intr = {
    deviceName: NAME,
    imageSize: [1280, 720],
    K: { fx: 1000, fy: 1000, cx: 640, cy: 360 },
    dist: { k1: 0, k2: 0, p1: 0, p2: 0, k3: 0 },
    rms: 0,
    date: '2026-11-18',
    approximate: true,
  };
  writeFileSync(INTR_FILE, JSON.stringify(intr));
  const cm = lookAtCamera({ azimuthDeg: -45, distanceM: 2.5, heightM: 1 }, intr as never);
  const cs = lookAtCamera({ azimuthDeg: 45, distanceM: 2.5, heightM: 1 }, intr as never);
  const calib = {
    savedAt: Date.now(),
    main: {
      deviceName: NAME,
      extr: cm.extr,
      reprojErrPx: 0.5,
      videoSize: [1280, 720],
      markers: [0, 1, 2, 3],
      method: 'test',
    },
    sub: {
      deviceName: NAME,
      extr: cs.extr,
      reprojErrPx: 0.5,
      videoSize: [1280, 720],
      markers: [0, 1, 2, 3],
      method: 'test',
    },
    measured: measuredLayout(cm.extr, cs.extr),
  };
  const ctx = await browser.newContext({ permissions: ['camera'] });
  // テスト環境（1つのブラウザで2台分を動かす）は処理速度・往復時間が実機より悪く、
  // その条件で中止されると確かめたいことが確かめられないので、関節以外の監視のしきい値を緩める
  await ctx.route('**/config/params.json', async (route) => {
    const params = await (await route.fetch()).json();
    params.monitor = {
      ...params.monitor,
      peerTimeoutS: 10,
      maxReprojErrPx: 1e6,
      minFps: 0,
      maxRttMs: 1e6,
    };
    await route.fulfill({ json: params });
  });
  await ctx.addInitScript(
    ([name, c]) => {
      localStorage.setItem('squat.deviceName', JSON.stringify(name));
      if (location.search.includes('role=main') && !sessionStorage.getItem('init')) {
        localStorage.setItem('squat.extrinsics', JSON.stringify(c));
        localStorage.setItem('squat.recordVideo', 'true');
        sessionStorage.setItem('init', '1');
      }
    },
    [BASE, calib] as const,
  );
  const main = await ctx.newPage();
  const sub = await ctx.newPage();
  await main.goto('/?role=main');
  await sub.goto('/?role=sub');
  const start = main.getByRole('button', { name: '測定開始' });
  await expect(start).toBeEnabled({ timeout: 90_000 });
  await start.click();
  await expect(main.locator('.statusbar')).toContainText('測定中');
  // 偽のカメラには人が映っていないが、必須の関節が見えないことでは中止しない
  await main.waitForTimeout(4000);
  await expect(main.locator('.alert-overlay')).toHaveCount(0);
  await expect(main.locator('.statusbar')).toContainText('測定中');
  // 測定停止を押すまで記録が続き、押すと保存される
  await main.getByRole('button', { name: '測定停止' }).click();
  await expect(main.locator('#toast')).toContainText('記録を保存しました', { timeout: 15_000 });
  await main.getByRole('button', { name: 'メニュー' }).click();
  await main.getByRole('button', { name: 'セッション一覧' }).click();
  const list = main.locator('.sheet').last();
  await expect(list.locator('tr')).toHaveCount(1);
  await expect(list).not.toContainText('中止：');
  // PCの「記録の確認」に、主端末と同じ記録（映像つき）が届いている
  await expect(main.locator('#toast')).toContainText('PCにも送りました', { timeout: 30_000 });
  const pc = await ctx.newPage();
  await pc.goto('/sessions.html');
  const row = pc.locator('tr').first();
  await expect(row).toContainText('リアルタイム');
  await expect(row.getByRole('button', { name: '映像' })).toBeVisible();
  await row.getByRole('button', { name: '再生' }).click();
  await expect(pc.locator('.sheet .player video')).toHaveCount(1);
  await expect(pc.locator('.sheet .player canvas.chart')).toBeVisible();
  await ctx.close();
});
