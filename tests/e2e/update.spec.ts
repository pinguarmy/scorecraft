import { test, expect, type Page } from './helpers/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readScore, getPlaybackScore } from '../../src/music/index';
import { ensureExportDetails, ensureReviewDetails, ensureNoteCorrection } from './helpers/workspace';

const evidence = 'evidence/v0.2';
async function importXml(page: Page, xml: string, filename: string) {
  await page.getByLabel('导入乐谱文件').setInputFiles({ name: filename, mimeType: 'application/xml', buffer: Buffer.from(xml) });
  // Existing score SVG remains visible during async hashing/import. Wait for the
  // new document identity before changing its controls, not merely any old SVG.
  await expect(page.locator('.score-source')).toHaveText(filename);
  await expect(page.locator('.score-paper svg').first()).toBeVisible();
}
async function seekBySlider(page: Page, beat: number) {
  const slider = page.getByLabel('播放位置', { exact: true });
  await slider.evaluate((element, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, String(value));
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }, beat);
  await expect(slider).toHaveValue(String(beat));
}

test.beforeAll(async () => { await mkdir(evidence, { recursive: true }); });

test('two same-title scores retain separate practice positions, settings and corrected titles', async ({ page }) => {
  await page.addInitScript({ path: path.resolve('scripts/inspect-audio.mjs') });
  await page.goto('/');
  const xmlA = (await readFile('public/samples/first-light.musicxml', 'utf8')).replace('<score-partwise', '<!--same-title-' + Date.now() + '--><score-partwise');
  const xmlB = xmlA.replace('<step>E</step><octave>4</octave>', '<step>F</step><octave>4</octave>');
  await importXml(page, xmlA, 'same-title-a.musicxml');
  const idA = await page.locator('.saved-document-list .active').locator('..').getAttribute('data-document-id');
  await page.getByRole('spinbutton', { name: '速度', exact: true }).fill('76');
  await page.getByRole('button', { name: '升高半音', exact: true }).click();
  await page.getByRole('button', { name: '静音 Piano · 左手', exact: true }).click();
  await page.getByRole('button', { name: /节拍器/ }).click();
  await page.getByRole('spinbutton', { name: '循环起始小节' }).fill('3');
  await page.getByRole('spinbutton', { name: '循环结束小节' }).fill('4');
  await page.getByRole('button', { name: '循环这几小节' }).click();
  await seekBySlider(page, 9);
  await expect(page.locator('.library-save-status')).toContainText('已保存到本机谱库');
  await expect.poll(async () => (await page.request.get(`/api/library/${encodeURIComponent(idA!)}`).then(response => response.json())).session.position).toBe(9);
  await page.reload();
  const scoreA = page.locator(`.saved-document-list li[data-document-id="${idA}"] button`);
  await scoreA.click();
  await expect(page.getByRole('spinbutton', { name: '速度', exact: true })).toHaveValue('76');
  await expect(page.locator('#transpose')).toContainText('+1');
  await expect(page.getByRole('button', { name: '取消静音 Piano · 左手', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: /节拍器/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '循环这几小节' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('播放位置', { exact: true })).toHaveValue('9');
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(async () => page.evaluate(() => (window as any).__scorecraftAudioRms())).toBeGreaterThan(.001);
  await expect.poll(async () => Number(await page.getByLabel('播放位置', { exact: true }).inputValue())).toBeGreaterThan(9.1);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await seekBySlider(page, 9);
  await importXml(page, xmlB, 'same-title-b.musicxml');
  const idB = await page.locator('.saved-document-list .active').locator('..').getAttribute('data-document-id');
  expect(idB).not.toBe(idA);
  const scoreB = page.locator(`.saved-document-list li[data-document-id="${idB}"] button`);
  await page.getByRole('spinbutton', { name: '速度', exact: true }).fill('112');
  await seekBySlider(page, 17);
  await expect.poll(async () => (await page.request.get(`/api/library/${encodeURIComponent(idB!)}`).then(response => response.json())).session.position).toBe(17);
  await page.reload();
  await expect(scoreA).toHaveCount(1);
  await expect(scoreB).toHaveCount(1);
  await scoreA.click();
  await expect(page.getByRole('spinbutton', { name: '速度', exact: true })).toHaveValue('76');
  await expect(page.getByLabel('播放位置', { exact: true })).toHaveValue('9');
  // Opening A promotes it; B now occupies the other row and retains its own state.
  await scoreB.click();
  await expect(page.getByRole('spinbutton', { name: '速度', exact: true })).toHaveValue('112');
  await expect(page.getByLabel('播放位置', { exact: true })).toHaveValue('17');
  await expect(page.locator('#transpose')).toContainText('0');
  await expect(page.getByRole('button', { name: '循环这几小节' })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: '编辑曲名', exact: true }).click();
  await page.getByLabel('曲名', { exact: true }).fill('初光 · 我的练习版');
  await page.getByLabel('作曲者', { exact: true }).fill('本地校订');
  await page.getByRole('button', { name: '保存曲名与作者', exact: true }).click();
  await expect(page.locator('.score-heading h2')).toHaveText('初光 · 我的练习版');
  await ensureExportDetails(page);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: /^MusicXML/ }).click();
  const metadataDownload = await pending;
  await metadataDownload.saveAs(`${evidence}/renamed.musicxml`);
  const renamed = await readScore(await readFile(`${evidence}/renamed.musicxml`));
  expect(renamed.title).toBe('初光 · 我的练习版');
  expect(renamed.composer).toBe('本地校订');
  await expect(scoreA).toHaveCount(1);
  await expect(scoreB).toHaveCount(1);
  await page.screenshot({ path: `${evidence}/sessions.png`, fullPage: true });
  await page.locator('.library-management > summary').click();
  await page.getByRole('button', { name: '清除本地历史', exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('scorecraft.documents.v2') || '[]').length)).toBe(0);
  await expect(scoreA).toHaveCount(1);
  await expect(scoreB).toHaveCount(1);
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(async () => Number(await page.getByLabel('播放位置', { exact: true }).inputValue())).toBeGreaterThan(17.1);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.reload();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('scorecraft.documents.v2') || '[]').length)).toBe(0);
  await expect(scoreA).toHaveCount(1);
  await expect(scoreB).toHaveCount(1);
  await writeFile(`${evidence}/session-summary.json`, JSON.stringify({ testedAt: new Date().toISOString(), distinctSameTitleDocuments: 2, scoreA: { tempo: 76, transpose: 1, sourceBeat: 9, leftMuted: true, loop: [3, 4] }, scoreB: { tempo: 112, transpose: 0, sourceBeat: 17 }, restoredActualAudio: true, metadataExportVerified: true, clearedHistoryDoesNotReappear: true }, null, 2));
});

test('written repeat jumps the actual source cursor and exports follow the selected order', async ({ page }) => {
  await page.addInitScript({ path: path.resolve('scripts/inspect-audio.mjs') });
  await page.goto('/');
  const xml = (await readFile('public/samples/repeat-study.musicxml', 'utf8')).replace('<score-partwise', '<!--repeat-export-' + Date.now() + '--><score-partwise');
  const original = await readScore(xml);
  expect(original.playback?.expanded).toBeTruthy();
  const expanded = getPlaybackScore(original);
  await importXml(page, xml, 'repeat-study.musicxml');
  const follow = page.getByRole('button', { name: '按谱面反复', exact: true });
  await expect(follow).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('spinbutton', { name: '速度', exact: true }).fill('240');
  await page.getByRole('button', { name: '播放', exact: true }).click();
  const positions: number[] = [];
  await expect.poll(async () => {
    const value = Number(await page.getByLabel('播放位置', { exact: true }).inputValue());
    positions.push(value);
    return positions.some((beat, i) => i > 0 && positions[i - 1] - beat > 1);
  }, { timeout: 15000, intervals: [70, 70, 100] }).toBeTruthy();
  await expect.poll(async () => page.evaluate(() => (window as any).__scorecraftAudioRms())).toBeGreaterThan(.001);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const secondPassPosition = Number(await page.getByLabel('播放位置', { exact: true }).inputValue());
  expect(secondPassPosition).toBeGreaterThanOrEqual(4);
  expect(secondPassPosition).toBeLessThan(8);
  await page.getByRole('spinbutton', { name: '速度', exact: true }).fill('180');
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(async () => Number(await page.getByLabel('播放位置', { exact: true }).inputValue())).toBeGreaterThan(secondPassPosition + .1);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.getByRole('spinbutton', { name: '速度', exact: true }).fill('240');
  const waveLengths: number[] = [];
  for (const repeats of [true, false]) {
    if (!repeats) await follow.click();
    await ensureExportDetails(page);
    const pending = page.waitForEvent('download');
    await page.getByRole('button', { name: /^WAV/ }).click();
    const download = await pending;
    const filename = `${evidence}/repeat-${repeats ? 'written' : 'straight'}.wav`;
    await download.saveAs(filename);
    const wave = await readFile(filename);
    waveLengths.push(wave.readUInt32LE(40));
  }
  expect(waveLengths[0]).toBeGreaterThan(waveLengths[1]);
  await page.getByRole('button', { name: '停止并回到开头' }).click();
  await page.getByRole('button', { name: '播放', exact: true }).click();
  const straight: number[] = [];
  await expect.poll(async () => {
    straight.push(Number(await page.getByLabel('播放位置', { exact: true }).inputValue()));
    return await page.getByRole('button', { name: '播放', exact: true }).isVisible();
  }, { timeout: 15000, intervals: [90, 90, 100] }).toBeTruthy();
  expect(straight.every((beat, i) => i === 0 || beat + .2 >= straight[i - 1])).toBeTruthy();
  await page.screenshot({ path: `${evidence}/repeat.png`, fullPage: true });
  await writeFile(`${evidence}/repeat-summary.json`, JSON.stringify({ testedAt: new Date().toISOString(), sourceBeats: original.totalBeats, writtenBeats: expanded.totalBeats, repeatSourcePositions: positions, straightPositions: straight, wavDataBytes: { written: waveLengths[0], straight: waveLengths[1] } }, null, 2));
});

// New genuine scan only; never delete pre-existing user jobs during acceptance.
test('one new real scan reopens its original without rescanning and deletes only its local scan files', async ({ page, request }) => {
  test.setTimeout(360_000);
  const healthRes = await request.get('/api/health');
  const health = healthRes.ok() ? await healthRes.json() : null;
  test.skip(!health?.engine?.available, 'Audiveris engine not available on this server; skipping genuine OMR scan');
  await page.goto('/');
  const before = await request.get('/api/jobs').then(r => r.json());
  const existing = new Set<string>(before.jobs.map((job: { id: string }) => job.id));
  let newId: string | undefined;
  let recognizeRequests = 0;
  page.on('request', req => { if (req.method() === 'POST' && req.url().endsWith('/api/recognize')) recognizeRequests++; });
  try {
    await page.getByLabel('导入乐谱文件').setInputFiles('public/samples/first-light.png');
    await expect(page.locator('.score-source')).toContainText('first-light.png', { timeout: 330_000 });
    const listed = await request.get('/api/jobs').then(r => r.json());
    newId = listed.jobs.find((job: { id: string }) => !existing.has(job.id))?.id;
    expect(newId).toBeTruthy();
    await expect(page.locator('.score-paper svg').first()).toBeVisible();
    await ensureReviewDetails(page);
    await ensureNoteCorrection(page);
    await page.locator('#note-select').selectOption({ index: 1 });
    const recognizedMidi = Number(await page.locator('#correct-pitch').inputValue());
    await page.locator('#correct-pitch').selectOption(String(recognizedMidi + 1));
    await page.getByRole('button', { name: '应用音高校正' }).click();
    await page.getByRole('button', { name: '编辑曲名', exact: true }).click();
    await page.getByLabel('曲名', { exact: true }).fill('扫描校正版 · 保留');
    await page.getByRole('button', { name: '保存曲名与作者', exact: true }).click();
    await page.reload();
    await page.getByText('谱库管理与导入帮助', { exact: true }).click();
    await page.getByRole('button', { name: '扫描档案', exact: true }).click();
    await page.getByRole('button', { name: /刷新扫描档案/ }).click();
    const row = page.locator(`[data-job-id="${newId}"]`);
    await expect(row).toBeVisible();
    await expect(page.getByRole('button', { name: /刷新扫描档案/ })).toBeEnabled();
    await row.getByRole('button', { name: /打开/ }).click();
    await expect(page.locator('.score-source')).toContainText('first-light.png');
    await expect(page.locator('.score-heading h2')).toHaveText('扫描校正版 · 保留');
    await ensureReviewDetails(page);
    await ensureNoteCorrection(page);
    await page.locator('#note-select').selectOption({ index: 1 });
    await expect(page.locator('#correct-pitch')).toHaveValue(String(recognizedMidi + 1));
    const original = page.locator('.original-preview img');
    if (!await original.isVisible()) await page.getByText('查看原谱', { exact: false }).first().click();
    await expect(original).toBeVisible();
    await expect.poll(() => original.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBeTruthy();
    expect(recognizeRequests).toBe(1);
    await page.screenshot({ path: `${evidence}/scan-library.png`, fullPage: true });
    await row.getByRole('button', { name: /删除/ }).click();
    await page.getByRole('button', { name: /确认删除/ }).click();
    await expect(row).toHaveCount(0);
    for (const suffix of ['', '/original', '/score']) expect((await request.get(`/api/jobs/${newId}${suffix}`)).status()).toBe(404);
    const after = await request.get('/api/jobs').then(r => r.json());
    expect([...existing].every(id => after.jobs.some((job: { id: string }) => job.id === id))).toBeTruthy();
    // Corrected/loaded XML remains usable in this page even though raw scan files were removed.
    await expect(page.getByRole('button', { name: '播放', exact: true })).toBeEnabled();
    await page.reload();
    await page.locator('.saved-document-list button, .recent-list button').filter({ hasText: '扫描校正版 · 保留' }).click();
    await expect(page.locator('.score-heading h2')).toHaveText('扫描校正版 · 保留');
    await expect(page.locator('.original-preview')).toHaveCount(0);
    await ensureReviewDetails(page);
    await ensureNoteCorrection(page);
    await page.locator('#note-select').selectOption({ index: 1 });
    await expect(page.locator('#correct-pitch')).toHaveValue(String(recognizedMidi + 1));
    await writeFile(`${evidence}/scan-library-summary.json`, JSON.stringify({ testedAt: new Date().toISOString(), newJobId: newId, genuineRecognitionRequests: recognizeRequests, reopenedOriginal: true, originalAndResultReturn404AfterDelete: true, preservedExistingJobs: existing.size, retainedCorrectedXmlAfterReload: true }, null, 2));
  } finally {
    if (newId && !existing.has(newId)) {
      const current = await request.get(`/api/jobs/${newId}`);
      if (current.ok()) {
        const job = await current.json();
        if (job.status === 'done' || job.status === 'error') await request.delete(`/api/jobs/${newId}`);
      }
    }
  }
});
