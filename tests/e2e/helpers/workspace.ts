import { expect, type Page, type Locator } from '@playwright/test';

/**
 * Strict workspace UI helpers targeting the 2026-11-03 restructuring.
 * All functions assert expected visibility directly without silent skips or legacy fallbacks.
 */

/**
 * Ensures the '声音' (Sound settings) details element is open and visible.
 */
export async function ensureSoundDetails(page: Page): Promise<Locator> {
  const details = page.locator('details.sound-settings');
  await expect(details).toBeVisible();
  const isOpen = await details.evaluate((el: HTMLElement) => el.hasAttribute('open'));
  if (!isOpen) {
    await details.locator('> summary').click();
  }
  await expect(details).toHaveAttribute('open', '');
  return details;
}

/**
 * Ensures the '识谱校对' (Review settings) details element is open and visible.
 */
export async function ensureReviewDetails(page: Page): Promise<Locator> {
  const details = page.locator('details.review-settings');
  await expect(details).toBeVisible();
  const isOpen = await details.evaluate((el: HTMLElement) => el.hasAttribute('open'));
  if (!isOpen) {
    await details.locator('> summary').click();
  }
  await expect(details).toHaveAttribute('open', '');
  return details;
}

/**
 * Ensures the '导出乐谱与音频' (Export settings) details element is open and visible.
 */
export async function ensureExportDetails(page: Page): Promise<Locator> {
  const details = page.locator('details.export-settings');
  await expect(details).toBeVisible();
  const isOpen = await details.evaluate((el: HTMLElement) => el.hasAttribute('open'));
  if (!isOpen) {
    await details.locator('> summary').click();
  }
  await expect(details).toHaveAttribute('open', '');
  return details;
}

/**
 * Ensures note correction section under '识谱校对' is visible.
 * In the new structure, note correction is a section inside details.review-settings.
 */
export async function ensureNoteCorrection(page: Page): Promise<void> {
  await ensureReviewDetails(page);
  const noteSelect = page.locator('#note-select');
  await expect(noteSelect).toBeVisible();
}

/**
 * Opens mobile sheet via dock buttons: '当前练习' or '工具'.
 * In mobile view (<= 999px), clicks the button in .mobile-tools-actions and asserts dialog is visible.
 */
export async function openMobileSheet(page: Page, action: '当前练习' | '工具'): Promise<Locator> {
  const button = page.getByRole('button', { name: action, exact: true });
  await expect(button).toBeVisible();
  await button.click();
  const dialog = page.locator('.inspector-settings[role="dialog"]');
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * Closes mobile sheet via close button '关闭练习工具' or Escape key.
 */
export async function closeMobileSheet(page: Page, viaEscape = false): Promise<void> {
  if (viaEscape) {
    await page.keyboard.press('Escape');
  } else {
    const closeBtn = page.getByRole('button', { name: '关闭练习工具', exact: true });
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();
  }
  const dialog = page.locator('.inspector-settings[role="dialog"]');
  await expect(dialog).toBeHidden();
}

/**
 * Generates an authored unique MusicXML fixture with a given title.
 * Used to avoid polluting shared test servers or collisions with previous runs.
 */
export function createAuthoredScoreXml(
  title: string,
  options: {
    measures?: number;
    composer?: string;
    largePadding?: boolean;
    parts?: { id: string; name: string }[];
  } = {},
): string {
  const composer = options.composer ?? 'ScoreCraft Authored Test';
  const padding = options.largePadding ? `<!--${'Authored large spacing padding '.repeat(20000)}-->` : '';
  const parts = options.parts ?? [{ id: 'P1', name: 'Piano' }];

  const partListXml = parts
    .map((p) => `<score-part id="${p.id}"><part-name>${p.name}</part-name></score-part>`)
    .join('');
  const measureCount = options.measures ?? 4;

  const measuresXml = Array.from({ length: measureCount }, (_, i) => {
    const measureNum = i + 1;
    const isFirst = measureNum === 1;
    const attributes = isFirst
      ? `<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>`
      : '';
    return `<measure number="${measureNum}">
      ${attributes}
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration>
        <voice>1</voice>
        <type>whole</type>
      </note>
    </measure>`;
  }).join('');

  const partsXml = parts.map((p) => `<part id="${p.id}">${measuresXml}</part>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work>
    <work-title>${title}</work-title>
  </work>
  <identification>
    <creator type="composer">${composer}</creator>
  </identification>
  ${padding}
  <part-list>
    ${partListXml}
  </part-list>
  ${partsXml}
</score-partwise>`;
}
