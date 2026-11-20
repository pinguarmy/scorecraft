import { test, expect } from './helpers/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureExportDetails } from './helpers/workspace';

const out = 'evidence/v0.4';
async function prepare(page: any) {
  await page.addInitScript({ path: path.resolve('scripts/inspect-audio.mjs') });
  await page.goto('/');
  await page.getByRole('button', { name: /先试一页示例/ }).click();
  await expect(page.locator('.score-paper svg').first()).toBeVisible();
}
test.beforeAll(async () => {
  await mkdir(out, { recursive: true });
});

test('live playback and downloaded WAV use local stereo piano recordings, never triangle notes', async ({
  page,
  baseURL,
}) => {
  const remote: string[] = [];
  const sampleRequests: string[] = [];
  const appOrigin = new URL(baseURL ?? 'http://127.0.0.1:4381').origin;
  page.on('request', (request) => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== appOrigin) remote.push(request.url());
    if (request.url().endsWith('.mp3')) sampleRequests.push(request.url());
  });
  await prepare(page);
  await page.getByRole('spinbutton', { name: '速度', exact: true }).fill('120');
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible({ timeout: 20000 });
  await expect
    .poll(async () =>
      page.evaluate(
        () => (window as any).__scorecraftAudio.events.filter((e: any) => e.type === 'sample' && !e.offline).length,
      ),
    )
    .toBeGreaterThan(0);
  await expect.poll(async () => page.evaluate(() => (window as any).__scorecraftAudioRms())).toBeGreaterThan(0.001);
  const live = await page.evaluate(() => ({
    events: (window as any).__scorecraftAudio.events,
    rms: (window as any).__scorecraftAudioRms(),
  }));
  expect(live.events.some((e: any) => e.type === 'triangle' || e.type === 'sine')).toBeFalsy();
  expect(
    live.events.filter((e: any) => e.type === 'sample').every((e: any) => e.channels === 2 && e.duration > 1),
  ).toBeTruthy();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.getByRole('spinbutton', { name: '循环结束小节' }).fill('4');
  await page.getByRole('spinbutton', { name: '循环起始小节' }).fill('3');
  await ensureExportDetails(page);
  await page.getByLabel('音频与 MIDI 导出范围').selectOption('excerpt');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: /^WAV/ }).click();
  const downloaded = await pending;
  await downloaded.saveAs(`${out}/piano-excerpt.wav`);
  const wav = await readFile(`${out}/piano-excerpt.wav`);
  expect(wav.subarray(0, 4).toString()).toBe('RIFF');
  const channels = wav.readUInt16LE(22);
  const rate = wav.readUInt32LE(24);
  const seconds = wav.readUInt32LE(40) / 2 / channels / rate;
  expect(channels).toBe(2);
  expect(rate).toBe(44100);
  expect(seconds).toBeCloseTo(4.5, 3);
  let sum = 0;
  let peak = 0;
  let stereoDifference = 0;
  for (let i = 44; i + 3 < wav.length; i += 4) {
    const l = wav.readInt16LE(i) / 32768;
    const r = wav.readInt16LE(i + 2) / 32768;
    sum += l * l + r * r;
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
    stereoDifference += Math.abs(l - r);
  }
  const rms = Math.sqrt(sum / ((wav.length - 44) / 2));
  expect(rms).toBeGreaterThan(0.001);
  expect(peak).toBeLessThanOrEqual(1);
  expect(stereoDifference).toBeGreaterThan(1);
  const offline = await page.evaluate(() => (window as any).__scorecraftAudio.events.filter((e: any) => e.offline));
  expect(offline.length).toBeGreaterThan(0);
  expect(offline.every((e: any) => e.type === 'sample')).toBeTruthy();
  expect(new Set(sampleRequests).size).toBe(30);
  expect(remote).toEqual([]);
  await page.screenshot({
    path: `${out}/piano-workspace.png`,
    fullPage: true,
    style: '.skip-link{visibility:hidden!important}',
  });
  await writeFile(
    `${out}/piano-summary.json`,
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        sampleFiles: new Set(sampleRequests).size,
        remoteRequests: remote,
        live,
        wav: { channels, rate, seconds, rms, peak, stereoDifference, bytes: wav.length },
        offlineSampleSources: offline.length,
        physicalSpeakerListening: 'not measured; actual recorded sample provenance and digital output verified',
      },
      null,
      2,
    ),
  );
});

test('sample failure is visible and retry works, cancelling slow load never starts music', async ({ page }) => {
  let fail = true;
  await page.route('**/audio/piano/*.mp3', async (route) => {
    if (fail) await route.abort('failed');
    else await route.continue();
  });
  await prepare(page);
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.locator('.audio-status.error')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__scorecraftAudio.events.length)).toBe(0);
  fail = false;
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.unroute('**/audio/piano/*.mp3');
  await page.reload();
  await page
    .getByRole('button', { name: /^打开乐谱：First Light/ })
    .first()
    .click();
  await expect(page.locator('.score-paper svg').first()).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/audio/piano/*.mp3', async (route) => {
    await gate;
    await route.continue();
  });
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消音色加载', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '取消加载', exact: true }).click();
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeVisible();
  const completed = page.waitForResponse((response) => response.url().endsWith('/C8.mp3'));
  release();
  await completed;
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__scorecraftAudio.events.length)).toBe(0);
  await page.unroute('**/audio/piano/*.mp3');
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await writeFile(
    `${out}/sample-errors-summary.json`,
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        failedLoadVisible: true,
        retryStartsRecordedPiano: true,
        cancelledLoadHasNoLateStart: true,
        noOscillatorFallback: true,
      },
      null,
      2,
    ),
  );
});

test('count-in remains clicks only, followed by sample sources and correct notation cursor', async ({ page }) => {
  await prepare(page);
  await page.getByRole('spinbutton', { name: '速度', exact: true }).fill('240');
  await page.getByRole('button', { name: '播放前预备一小节', exact: true }).click();
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.locator('.count-in-status.is-counting')).toBeVisible({ timeout: 20000 });
  await expect(page.getByLabel('播放位置', { exact: true })).toHaveValue('0');
  await expect
    .poll(async () =>
      page.evaluate(() => (window as any).__scorecraftAudio.events.filter((e: any) => e.type === 'sample').length),
    )
    .toBeGreaterThan(0);
  const events = await page.evaluate(() => (window as any).__scorecraftAudio.events);
  const clicks = events.filter((e: any) => e.type === 'square');
  const firstSample = events.find((e: any) => e.type === 'sample');
  expect(clicks).toHaveLength(4);
  expect(firstSample.scheduledAt - clicks[0].scheduledAt).toBeGreaterThanOrEqual(0.98);
  expect(events.some((e: any) => e.type === 'triangle')).toBeFalsy();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await writeFile(
    `${out}/sample-count-in-summary.json`,
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        countClicks: clicks.length,
        sampleDelay: firstSample.scheduledAt - clicks[0].scheduledAt,
        noTriangle: true,
      },
      null,
      2,
    ),
  );
});
