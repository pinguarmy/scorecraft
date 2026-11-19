import { test, expect } from './helpers/test';
import { mkdir, writeFile } from 'node:fs/promises';
const out = 'evidence/v0.6.1';
test.beforeAll(async () => { await mkdir(out, { recursive: true }); });
test('playing across a native page boundary turns the page without seeking again', async ({ page }) => {
  const measures = Array.from({ length: 80 }, (_, index) => `<measure number="${index + 1}">${index === 0 ? '<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>' : ''}${Array.from({ length: 4 }, () => '<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>').join('')}</measure>`).join('');
  const xml = `<?xml version="1.0"?><score-partwise><part-list><score-part id="P"><part-name>Follow control</part-name></score-part></part-list><part id="P">${measures}</part></score-partwise>`;
  await page.goto('/');
  await page.getByLabel('导入乐谱文件').setInputFiles({ name: 'original-follow-control.musicxml', mimeType: 'application/xml', buffer: Buffer.from(xml) });
  await expect(page.locator('.score-render-host svg').first()).toBeVisible();
  await page.getByLabel('跟谱方式', { exact: true }).selectOption('page');
  await expect.poll(() => page.locator('.score-render-host svg').count()).toBeGreaterThan(1);
  const position = page.getByLabel('播放位置', { exact: true });
  let boundary = 0;
  for (let beat = 4; beat < 320; beat += 4) {
    await position.fill(String(beat));
    await expect(page.locator('.score-render-host')).toHaveAttribute('data-source-measure', String(beat / 4 + 1));
    const pageNumber = await page.locator('.score-render-host img[id^="cursorImg"]').evaluate(el => Number(el.parentElement?.dataset.scorePage));
    if (pageNumber > 1) { boundary = beat; break; }
  }
  expect(boundary).toBeGreaterThan(0);
  await page.getByRole('spinbutton', { name: '速度', exact: true }).fill('240');
  await position.fill(String(boundary - 1));
  await expect.poll(() => page.locator('.score-render-host img[id^="cursorImg"]').evaluate(el => Number(el.parentElement?.dataset.scorePage))).toBe(1);
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await expect.poll(() => page.locator('.score-render-host img[id^="cursorImg"]').evaluate(el => Number(el.parentElement?.dataset.scorePage))).toBe(2);
  await expect.poll(() => page.locator('.score-render-host').evaluate(el => el.scrollLeft)).toBeGreaterThan(100);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.getByRole('button', { name: '上一页乐谱', exact: true }).click();
  await expect.poll(() => page.locator('.score-render-host').evaluate(el => el.scrollLeft)).toBe(0);
  await page.screenshot({ path: `${out}/page-follow.png`, fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.locator('.score-render-host svg').count()).toBeGreaterThan(1);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await expect(page.getByRole('button', { name: '下一页乐谱', exact: true })).toBeVisible();
  await writeFile(`${out}/playing-follow-summary.json`, JSON.stringify({ testedAt: new Date().toISOString(), originalAuthoredMusic: true, boundaryBeat: boundary, actualPlayingTurnsPage: true, pausedManualPreviousPageRetained: true }, null, 2));
});
