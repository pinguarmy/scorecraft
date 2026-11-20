import { test, expect } from './helpers/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { ensureNoteCorrection, ensureReviewDetails } from './helpers/workspace';
const xml = (title: string) =>
  `<score-partwise><work><work-title>${title}</work-title></work><part-list><score-part id="P"><part-name>Piano</part-name></score-part></part-list><part id="P"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part></score-partwise>`;

test('a failed library read cannot turn an old import into a replacement for a saved correction', async ({
  browser,
}) => {
  const title = `Original read protection ${Date.now()}`;
  const file = { name: `${title}.musicxml`, mimeType: 'application/xml', buffer: Buffer.from(xml(title)) };
  const context = await browser.newContext();
  const freshContext = await browser.newContext();
  try {
    const first = await context.newPage();
    await first.goto('/');
    await first.getByLabel('导入乐谱文件').setInputFiles(file);
    await expect(first.locator('.library-save-status')).toContainText('已保存到本机谱库');
    await ensureReviewDetails(first);
    await ensureNoteCorrection(first);
    await first.locator('#note-select').selectOption({ index: 1 });
    await first.locator('#correct-pitch').selectOption('62');
    await first.getByRole('button', { name: '应用音高校正', exact: true }).click();
    await expect(first.locator('.library-save-status')).toContainText('已保存到本机谱库');
    const list = await first.request.get('/api/library').then((r) => r.json());
    const metadata = list.documents.find((d: any) => d.title === title);
    const endpoint = `/api/library/${encodeURIComponent(metadata.id)}`;
    const before = await first.request.get(endpoint).then((r) => r.json());
    expect(before.xml).toContain('<step>D</step>');
    await first.close();

    // This check targets the server-read path, not same-browser outbox recovery.
    const page = await freshContext.newPage();
    await page.goto('/');
    await page.getByRole('button', { name: /先试一页示例/ }).click();
    await expect(page.locator('.score-heading h2')).toHaveText('First Light · 初光');
    await expect(page.locator('.library-save-status')).toContainText('已保存到本机谱库');
    let targetReads = 0;
    let targetWrites = 0;
    await page.route('**/api/library/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (decodeURIComponent(url.pathname) === `/api/library/${metadata.id}` && request.method() === 'GET') {
        targetReads++;
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Authored test read failure' }),
        });
      } else {
        if (
          decodeURIComponent(url.pathname).startsWith(`/api/library/${metadata.id}`) &&
          ['PUT', 'PATCH'].includes(request.method())
        )
          targetWrites++;
        await route.continue();
      }
    });
    await page.getByLabel('导入乐谱文件').setInputFiles(file);
    await expect(page.getByRole('alert')).toContainText('未打开这份谱');
    expect(targetReads).toBe(1);
    await expect(page.locator('.score-heading h2')).toHaveText('First Light · 初光');
    await expect(page.getByRole('button', { name: '重试保存', exact: true })).toHaveCount(0);
    const unchanged = await page.request.get(endpoint).then((r) => r.json());
    expect(unchanged.xml).toBe(before.xml);
    expect(targetWrites).toBe(0);
    await page.unroute('**/api/library/**');
    await page.getByLabel('导入乐谱文件').setInputFiles(file);
    await expect(page.locator('.score-heading h2')).toHaveText(title);
    await ensureReviewDetails(page);
    await ensureNoteCorrection(page);
    await page.locator('#note-select').selectOption({ index: 1 });
    await expect(page.locator('.note-original strong')).toHaveText('D4');
    await mkdir('evidence/v0.6.5', { recursive: true });
    await writeFile(
      'evidence/v0.6.5/read-protection-summary.json',
      JSON.stringify(
        {
          testedAt: new Date().toISOString(),
          authoredOnly: true,
          savedCorrectionBefore: 'D4',
          readFailureInjected: true,
          currentScoreRetained: 'First Light',
          targetWritesDuringReadFailure: targetWrites,
          savedXmlUnchanged: true,
          reopeningAfterRecovery: 'D4',
        },
        null,
        2,
      ),
    );
  } finally {
    await Promise.all([context.close(), freshContext.close()]);
  }
});
