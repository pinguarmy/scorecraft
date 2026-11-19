import { test, expect, type Page } from './helpers/test';
import { mkdir, writeFile } from 'node:fs/promises';
const out = 'evidence/v0.6.2';
async function demo(page: Page) {
  await page.goto('/'); await page.getByRole('button', { name: /先试一页示例/ }).click();
  await expect(page.locator('.score-heading h2')).toContainText('First Light');
  await expect(page.locator('.score-paper svg').first()).toBeVisible();
  await expect(page.locator('.job-status')).toHaveCount(0);
}
async function openDetails(page: Page, name: string) {
  const summary = page.locator('summary').filter({ hasText: new RegExp(`^${name}`) }).first();
  if (await summary.count() > 0 && await summary.locator('..').getAttribute('open') === null) {
    await summary.click();
  }
}
test.beforeAll(async () => { await mkdir(out, { recursive: true }); });

test('active listening and loop settings stay visible with a safe silence recovery', async ({ page }) => {
  await demo(page);
  const solo = page.getByRole('button', { name: '独奏 Piano · 右手', exact: true });
  await solo.click();
  await expect(page.locator('.practice-state')).toContainText('只听');
  await expect(page.locator('.practice-state')).toContainText('右手');
  await openDetails(page, '分段练习');
  await page.getByRole('button', { name: /从当前小节练4小节|练当前起的4小节/ }).click();
  await expect(page.getByLabel('循环起始小节', { exact: true })).toHaveValue('1');
  await expect(page.getByLabel('循环结束小节', { exact: true })).toHaveValue('4');
  await expect(page.locator('.practice-state')).toContainText(/1.*4/);
  await page.getByRole('button', { name: '结束循环', exact: true }).click();
  await expect(page.getByRole('button', { name: '循环这几小节', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: '全部声部', exact: true }).click();
  for (const part of ['右手', '左手']) await page.getByRole('button', { name: `静音 Piano · ${part}`, exact: true }).click();
  await expect(page.locator('.practice-state')).toContainText(/全部.*静音|所有.*静音/);
  await page.getByRole('button', { name: '恢复全部声部', exact: true }).click();
  await expect(page.getByRole('button', { name: '取消静音 Piano · 右手', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '取消静音 Piano · 左手', exact: true })).toHaveCount(0);
  await page.screenshot({ path: `${out}/desktop.png`, fullPage: false });
});

test('precise jump and relative speed controls preserve source position and listening choice', async ({ page }) => {
  await page.addInitScript({ path: 'scripts/inspect-audio.mjs' });
  await demo(page);
  await page.getByRole('button', { name: '独奏 Piano · 左手', exact: true }).click();
  await openDetails(page, '播放选项');
  await page.getByLabel('跳到小节', { exact: true }).fill('6');
  await page.getByRole('button', { name: '跳转', exact: true }).click();
  await expect(page.locator('.score-render-host')).toHaveAttribute('data-source-measure', '6');
  const position = await page.getByLabel('播放位置', { exact: true }).inputValue();
  await page.getByRole('button', { name: '放慢至基准速度75%', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: '速度', exact: true })).toHaveValue('66');
  await page.getByRole('button', { name: '恢复基准速度', exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: '速度', exact: true })).toHaveValue('88');
  await expect(page.getByLabel('播放位置', { exact: true })).toHaveValue(position);
  await expect(page.getByRole('button', { name: '独奏 Piano · 左手', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByLabel('跳到小节', { exact: true }).fill('99');
  await page.getByRole('button', { name: '跳转', exact: true }).click();
  await expect(page.getByLabel('播放位置', { exact: true })).toHaveValue(position);
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__scorecraftAudioRms())).toBeGreaterThan(.0001);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
});

test('view preferences survive reopening without automatic playback and remain per document', async ({ page }) => {
  await demo(page);
  await page.getByLabel('跟谱方式', { exact: true }).selectOption('page');
  await page.getByRole('button', { name: '自动跟谱', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: /^打开乐谱：First Light/ }).first().click();
  await expect(page.getByLabel('跟谱方式', { exact: true })).toHaveValue('page');
  await expect(page.getByRole('button', { name: '自动跟谱', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeVisible();
  await page.getByRole('button', { name: /试试反复练习示例/ }).click();
  await expect(page.locator('.score-heading h2')).not.toContainText('First Light');
  await expect(page.getByLabel('跟谱方式', { exact: true })).toHaveValue('scroll');
  await expect(page.getByRole('button', { name: '自动跟谱', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('manual segment entry accepts a later start first and keeps changed values visible', async ({ page }) => {
  await demo(page);
  await openDetails(page, '分段练习');
  await page.getByLabel('循环起始小节', { exact: true }).fill('5');
  await expect(page.getByLabel('循环起始小节', { exact: true })).toHaveValue('5');
  await expect(page.getByLabel('循环结束小节', { exact: true })).toHaveValue('5');
  await page.getByLabel('循环结束小节', { exact: true }).fill('8');
  await page.getByRole('button', { name: '循环这几小节', exact: true }).click();
  await expect(page.locator('.practice-state')).toContainText(/5.*8/);
  await expect(page.locator('.practice-state')).toContainText('循环');
  await page.getByRole('button', { name: '升高半音', exact: true }).click();
  await expect(page.locator('.practice-state')).toContainText('+1');
});

test('score warnings are discoverable before the paper instead of after a long score', async ({ page }) => {
  await page.goto('/');
  const xml = '<score-partwise><part-list><score-part id="P"><part-name>Warning check</part-name></score-part></part-list><part id="P"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type><notations><fermata/></notations></note></measure></part></score-partwise>';
  await page.getByLabel('导入乐谱文件').setInputFiles({ name: 'original-warning-check.musicxml', mimeType: 'application/xml', buffer: Buffer.from(xml) });
  await expect(page.locator('.score-heading h2')).toContainText('未命名');
  await expect(page.locator('.score-paper svg').first()).toBeVisible();
  const notice = page.locator('.review-notice');
  await expect(notice).toHaveCount(1);
  expect(await notice.evaluate(el => Boolean(el.compareDocumentPosition(document.querySelector('.score-paper')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await expect(notice).toContainText(/校对与原稿/);
  await notice.getByRole('button', { name: /校对与原稿/ }).click();
  await expect(page.locator('details.review-settings')).toHaveAttribute('open', '');
  await expect(page.locator('details.review-settings')).toContainText(/速度|延长/);
});

test('phone opens at the score, retains the single dock and can return to the library', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page);
  await expect(page.locator('.score-heading h2')).toBeInViewport();
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeInViewport();
  await expect(page.locator('section.transport')).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: `${out}/mobile.png`, fullPage: false });
  await page.getByRole('button', { name: '谱库与导入', exact: true }).click();
  await expect(page.locator('button.import-button')).toBeInViewport();
  await writeFile(`${out}/ux-summary.json`, JSON.stringify({ testedAt: new Date().toISOString(), phoneWidth: 390, singlePlaybackDock: true, scoreFirstAfterImport: true, returnToLibrary: true, noHorizontalOverflow: true }, null, 2));
});
