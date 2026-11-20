import { test, expect } from './helpers/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { readScore } from '../../src/music/index';
import { zipSync, strToU8 } from 'fflate';
import { ensureReviewDetails, ensureNoteCorrection, ensureExportDetails } from './helpers/workspace';

// Cross-module acceptance only. Music and HTTP unit behavior belong to their owners.
test('real notation, digital audio, practice controls, correction, exports and local persistence', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript({ path: path.resolve('scripts/inspect-audio.mjs') });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '从一页谱开始' })).toBeVisible();
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: /先试一页示例/ }).click();
  await expect(page.locator('.score-heading h2')).toHaveText(/First Light/);
  const demoId = await page.locator('.saved-document-list .active').locator('..').getAttribute('data-document-id');
  await expect(page.locator('.score-paper svg').first()).toBeVisible();
  await expect(page.getByRole('button', { name: '静音 Piano · 右手', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '静音 Piano · 左手', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await expect
    .poll(async () => page.evaluate(() => (window as any).__scorecraftAudioRms()), { timeout: 8000 })
    .toBeGreaterThan(0.001);
  const digitalAudio = await page.evaluate(() => ({
    rms: (window as any).__scorecraftAudioRms(),
    oscillatorStarts: (window as any).__scorecraftAudio.oscillatorStarts,
  }));
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.getByRole('spinbutton', { name: '速度', exact: true }).fill('72');
  await expect(page.getByRole('spinbutton', { name: '速度', exact: true })).toHaveValue('72');
  await page.getByRole('button', { name: '升高半音', exact: true }).click();
  await expect(page.locator('#transpose')).toContainText('+1');
  const mute = page.getByRole('button', { name: '静音 Piano · 左手', exact: true });
  await mute.click();
  await expect(page.getByRole('button', { name: '取消静音 Piano · 左手', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: /节拍器/ }).click();
  await expect(page.getByRole('button', { name: /节拍器/ })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('spinbutton', { name: '循环起始小节' }).fill('2');
  await page.getByRole('spinbutton', { name: '循环结束小节' }).fill('3');
  await page.getByRole('button', { name: '循环这几小节' }).click();
  await expect(page.getByRole('button', { name: '循环这几小节' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '停止并回到开头' }).click();
  // Correct a specific note, then undo once and reapply, inspecting real XML on export.
  await ensureReviewDetails(page);
  await ensureNoteCorrection(page);
  const select = page.locator('#note-select');
  const firstId = await select.locator('option').nth(1).getAttribute('value');
  expect(firstId).toBeTruthy();
  await select.selectOption(firstId!);
  const originalMidi = Number(await page.locator('#correct-pitch').inputValue());
  await page.locator('#correct-pitch').selectOption(String(originalMidi + 2));
  await page.getByRole('button', { name: '应用音高校正' }).click();
  await expect(page.getByRole('status').filter({ hasText: '已将第' })).toBeVisible();
  await page.getByRole('button', { name: /撤销校正/ }).click();
  await expect(page.getByRole('status').filter({ hasText: '已撤销' })).toBeVisible();
  await select.selectOption(firstId!);
  await page.locator('#correct-pitch').selectOption(String(originalMidi + 2));
  await page.getByRole('button', { name: '应用音高校正' }).click();
  await mkdir('evidence/browser-exports', { recursive: true });
  const exports: { filename: string; bytes: number; header: string }[] = [];
  for (const format of ['MusicXML', 'MIDI', 'WAV']) {
    await ensureExportDetails(page);
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: new RegExp(`^${format}`) }).click();
    const download = await pending;
    const destination = path.join('evidence/browser-exports', download.suggestedFilename());
    await download.saveAs(destination);
    const bytes = await readFile(destination);
    expect(bytes.length).toBeGreaterThan(30);
    if (format === 'MIDI') expect(bytes.subarray(0, 4).toString()).toBe('MThd');
    if (format === 'WAV') expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
    if (format === 'MusicXML') {
      expect(bytes.toString()).toContain('score-partwise');
      const exported = await readScore(bytes.toString());
      expect(exported.parts.flatMap((part) => part.notes).find((note) => note.id === firstId)?.midi).toBe(
        originalMidi + 3,
      );
    }
    exports.push({ filename: destination, bytes: bytes.length, header: bytes.subarray(0, 12).toString() });
  }
  await page.getByRole('button', { name: '循环这几小节' }).click();
  await page.getByRole('button', { name: '下一小节', exact: true }).click();
  await expect(page.locator('.paper-footer')).toContainText('第 2 / 8 小节');
  await page.screenshot({ path: 'evidence/desktop.png', fullPage: true });
  await page.reload();
  const demoBtn = page.locator(`.saved-document-list li[data-document-id="${demoId}"] button`);
  await expect(demoBtn).toBeVisible();
  await demoBtn.click();
  await expect(page.locator('.score-heading h2')).toHaveText(/First Light/);
  // No score/audio dependency is fetched externally during local XML practice.
  const unexpectedRemoteRequests: string[] = [];
  page.on('request', (request) => {
    if (
      /^https?:/.test(request.url()) &&
      !request.url().startsWith('http://127.0.0.1') &&
      !request.url().startsWith('http://localhost')
    )
      unexpectedRemoteRequests.push(request.url());
  });
  // Samples are local HTTP assets, not an offline service-worker cache. Load
  // them once after a full reload, then verify playback with no network.
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(async () => page.evaluate(() => (window as any).__scorecraftAudioRms())).toBeGreaterThan(0.001);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.context().setOffline(true);
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(async () => page.evaluate(() => (window as any).__scorecraftAudioRms())).toBeGreaterThan(0.001);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.context().setOffline(false);
  expect(unexpectedRemoteRequests).toEqual([]);
  // Invalid files do not silently replace the current score with a demo.
  await page.getByLabel('导入乐谱文件').setInputFiles({
    name: 'broken.musicxml',
    mimeType: 'application/xml',
    buffer: Buffer.from('<score-partwise><part>'),
  });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('.score-heading h2')).toHaveText(/First Light/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'evidence/mobile.png', fullPage: true });
  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(overflow.content).toBeLessThanOrEqual(overflow.viewport + 2);
  expect(errors).toEqual([]);
  await writeFile(
    'evidence/browser-summary.json',
    JSON.stringify(
      { testedAt: new Date().toISOString(), digitalAudio, exports, mobile: overflow, pageErrors: errors },
      null,
      2,
    ),
  );
});

test('imports both MusicXML and compressed MXL without an OMR engine', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('导入乐谱文件').setInputFiles('public/samples/first-light.musicxml');
  await expect(page.locator('.score-heading h2')).toHaveText(/First Light/);
  await expect(page.locator('.score-paper svg').first()).toBeVisible();
  const xml = await readFile('public/samples/repeat-study.musicxml', 'utf8');
  const mxl = zipSync({
    'META-INF/container.xml': strToU8(
      '<?xml version="1.0"?><container><rootfiles><rootfile full-path="score.musicxml" media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>',
    ),
    'score.musicxml': strToU8(xml),
  });
  await page.getByLabel('导入乐谱文件').setInputFiles({
    name: 'repeat-study.mxl',
    mimeType: 'application/vnd.recordare.musicxml',
    buffer: Buffer.from(mxl),
  });
  await expect(page.locator('.score-heading h2')).toHaveText(/Returning Steps/);
  await expect(page.locator('.score-paper svg').first()).toBeVisible();
});

test('a genuine PDF upload completes through the visible OMR workflow', async ({ page }) => {
  test.setTimeout(360_000);
  const healthRes = await page.request.get('/api/health');
  const health = healthRes.ok() ? await healthRes.json() : null;
  test.skip(
    !health?.engine?.available,
    'Audiveris engine not available on this server; skipping genuine OMR PDF upload',
  );
  await page.goto('/');
  await page.getByLabel('导入乐谱文件').setInputFiles('public/samples/first-light.pdf');
  await expect(page.locator('.score-source')).toContainText('本地识别 · first-light.pdf', { timeout: 330_000 });
  await expect(page.locator('.score-paper svg').first()).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '识别结果已载入' })).toBeVisible();
  await page.screenshot({ path: 'evidence/recognized-pdf-desktop.png', fullPage: true });
});
