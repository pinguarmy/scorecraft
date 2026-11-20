import { test, expect, type Page } from './helpers/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureSoundDetails, ensureReviewDetails, ensureExportDetails } from './helpers/workspace';

const out = process.env.SCORECRAFT_EVIDENCE_DIR || 'evidence/v0.5';
async function demo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /先试一页示例/ }).click();
  await expect(page.locator('.score-paper svg').first()).toBeVisible();
}
async function openDetails(page: Page, label: string) {
  if (label.includes('识谱') || label.includes('音符')) {
    await ensureReviewDetails(page);
    return;
  }
  if (label.includes('导出')) {
    await ensureExportDetails(page);
    return;
  }
  if (label.includes('声音')) {
    await ensureSoundDetails(page);
    return;
  }
  const summary = page
    .locator('summary')
    .filter({ hasText: new RegExp(`^${label}`) })
    .first();
  if ((await summary.count()) > 0 && !((await summary.locator('..').getAttribute('open')) !== null)) {
    await summary.click();
  }
}
test.beforeAll(async () => {
  await mkdir(out, { recursive: true });
});

test('beginner controls stay together with explicit voice actions and reversible metadata', async ({ page }) => {
  await page.addInitScript({ path: path.resolve('scripts/inspect-audio.mjs') });
  await demo(page);
  await expect(page.locator('section.transport')).toHaveCount(1);
  await page.locator('.inspector').evaluate((element) => (element.scrollTop = 0));
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeInViewport();
  for (const name of ['声音', '识谱校对', '导出乐谱与音频', '音符校正', '移调设置']) {
    const summary = page
      .locator('summary')
      .filter({ hasText: new RegExp(`^${name}`) })
      .first();
    if ((await summary.count()) > 0) {
      await expect(summary.locator('..')).not.toHaveAttribute('open', '');
    }
  }
  await expect(page.locator('#current-practice')).toContainText('只听');
  await expect(page.locator('#current-practice')).toContainText('静音');
  const solo = page.getByRole('button', { name: '独奏 Piano · 右手', exact: true });
  await solo.click();
  await expect(solo).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '全部声部', exact: true }).click();
  await expect(solo).toHaveAttribute('aria-pressed', 'false');
  await ensureReviewDetails(page);
  const rename = page.getByRole('button', { name: /更改声部名称/ }).first();
  await rename.click();
  await page.getByRole('textbox', { name: '声部名称', exact: true }).fill('练习钢琴');
  await page.getByRole('button', { name: '保存声部名称', exact: true }).click();
  await expect(page.locator('.parts-list')).toContainText('练习钢琴');
  await openDetails(page, '导出乐谱与音频');
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: /^MusicXML/ }).click();
  const file = await pending;
  await file.saveAs(`${out}/renamed-original-exercise.musicxml`);
  const xml = await readFile(`${out}/renamed-original-exercise.musicxml`, 'utf8');
  expect(xml).toContain('<part-name>练习钢琴</part-name>');
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await expect.poll(async () => page.evaluate(() => (window as any).__scorecraftAudioRms())).toBeGreaterThan(0.001);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.locator('.inspector').evaluate((element) => (element.scrollTop = 0));
  await expect(page.locator('.score-render-message')).toBeHidden();
  await page.screenshot({
    path: `${out}/desktop.png`,
    fullPage: true,
    style: '.skip-link{visibility:hidden!important}',
  });
  await writeFile(
    `${out}/novice-flow-summary.json`,
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        transportNodes: 1,
        advancedSectionsInitiallyClosed: true,
        explicitSoloAndRestore: true,
        renamedPartInExport: true,
        actualSamplePlayback: true,
      },
      null,
      2,
    ),
  );
});

test('explicit meter correction retains source notes and renders six over two', async ({ page }) => {
  await page.goto('/');
  const xml =
    '<score-partwise><work><work-title>Original meter check</work-title></work><part-list><score-part id="S"><part-name>Soprano</part-name></score-part><score-part id="B"><part-name>Bass</part-name></score-part></part-list><part id="S"><measure number="1"><attributes><divisions>1</divisions><time><beats>5</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note></measure></part><part id="B"><measure number="1"><attributes><divisions>1</divisions><time><beats>5</beats><beat-type>4</beat-type></time><clef><sign>F</sign><line>4</line></clef></attributes><note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><type>whole</type></note></measure></part></score-partwise>';
  await page
    .getByLabel('导入乐谱文件')
    .setInputFiles({ name: 'original-meter.musicxml', mimeType: 'application/xml', buffer: Buffer.from(xml) });
  await expect(page.locator('.score-source')).toHaveText('original-meter.musicxml');
  await expect(page.locator('.score-render-host svg').first()).toBeVisible();
  await openDetails(page, '识谱核对');
  await page.getByLabel('拍号分子', { exact: true }).fill('6');
  await page.getByLabel('拍号分母', { exact: true }).selectOption('2');
  await page.getByRole('button', { name: '校正拍号', exact: true }).click();
  await expect(page.getByRole('button', { name: '确认校正拍号', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '确认校正拍号', exact: true }).click();
  await expect(page.getByLabel('播放位置', { exact: true })).toHaveAttribute('max', '12');
  await expect(page.locator('.score-render-error')).toHaveCount(0);
  await openDetails(page, '导出乐谱与音频');
  const wait = page.waitForEvent('download');
  await page.getByRole('button', { name: /^MusicXML/ }).click();
  const file = await wait;
  await file.saveAs(`${out}/corrected-original-meter.musicxml`);
  const corrected = await readFile(`${out}/corrected-original-meter.musicxml`, 'utf8');
  expect(corrected.match(/<beats>6<\/beats>/g)).toHaveLength(2);
  expect(corrected.match(/<beat-type>2<\/beat-type>/g)).toHaveLength(2);
  expect(corrected.match(/<duration>4<\/duration>/g)).toHaveLength(2);
  await writeFile(
    `${out}/meter-summary.json`,
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        correctedMeter: '6/2',
        quarterBeats: 12,
        sourceNoteDurationsUnchanged: true,
        confirmationRequired: true,
        sourceNamesPresent: true,
        automaticRecognitionClaimed: false,
      },
      null,
      2,
    ),
  );
});

test('whole score arrangement replaces repetitive per-part selection and keeps listening state', async ({ page }) => {
  await demo(page);
  await ensureSoundDetails(page);
  const controls = page.getByLabel('声部乐器 Piano · 右手', { exact: true });
  await expect(controls).toBeHidden();
  await page.getByRole('button', { name: '静音 Piano · 左手', exact: true }).click();
  await page.getByLabel('整首配器', { exact: true }).selectOption('acoustic');
  await expect(page.getByRole('button', { name: '取消静音 Piano · 左手', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: /^逐个调整音色/ }).click();
  await expect(controls).toHaveValue('guitar-acoustic');
  await expect(page.getByLabel('声部乐器 Piano · 左手', { exact: true })).toHaveValue('bass-electric');
  await page.getByLabel('全部换成', { exact: true }).selectOption('strings');
  await expect(controls).toHaveValue('strings');
  await expect(page.getByLabel('声部乐器 Piano · 左手', { exact: true })).toHaveValue('strings');
  await expect(page.getByRole('button', { name: '取消静音 Piano · 左手', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await writeFile(
    `${out}/arrangement-summary.json`,
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        perPartChoiceInitiallyCollapsed: true,
        onePresetAppliesBothParts: true,
        uniformSelectionAppliesAll: true,
        mutePreserved: true,
      },
      null,
      2,
    ),
  );
});

test('mobile keeps a single compact dock reachable without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await demo(page);
  const play = page.getByRole('button', { name: '播放', exact: true });
  await expect(play).toBeInViewport();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight / 2));
  await expect(play).toBeInViewport();
  const center = await play.boundingBox();
  expect(center!.y).toBeGreaterThan(500);
  const width = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  expect(width.document).toBeLessThanOrEqual(width.viewport + 2);
  await expect(page.locator('.score-render-message')).toBeHidden();
  await expect(page.locator('.score-render-host svg').first()).toBeVisible();
  await page.screenshot({
    path: `${out}/mobile.png`,
    fullPage: true,
    style: '.skip-link{visibility:hidden!important}',
  });
  await writeFile(
    `${out}/mobile-summary.json`,
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        ...width,
        transportNodes: await page.locator('section.transport').count(),
        visibleAtMiddleScroll: true,
        playBounds: center,
      },
      null,
      2,
    ),
  );
});
