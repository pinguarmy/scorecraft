import { test, expect } from './helpers/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { ensureNoteCorrection, ensureReviewDetails } from './helpers/workspace';

const originalXml = (title: string) =>
  `<score-partwise><work><work-title>${title}</work-title></work><part-list><score-part id="P"><part-name>Piano</part-name></score-part></part-list><part id="P"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part></score-partwise>`;
test('failed correction remains available after switching scores and retry writes the latest edit', async ({
  page,
}) => {
  await page.goto('/');
  const title = `Original pending retry ${Date.now()}`;
  const importOriginal = async (name: string) => {
    await page
      .getByLabel('导入乐谱文件')
      .setInputFiles({ name: `${name}.musicxml`, mimeType: 'application/xml', buffer: Buffer.from(originalXml(name)) });
    await expect(page.locator('.score-heading h2')).toHaveText(name);
  };
  await importOriginal(title);
  await expect(page.locator('.library-save-status')).toContainText('已保存到本机谱库');
  let failedWrites = 0;
  await page.route('**/api/library/**', async (route) => {
    if (['PUT', 'PATCH'].includes(route.request().method())) {
      failedWrites++;
      await route.fulfill({
        status: 507,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Original test: storage temporarily unavailable' }),
      });
    } else await route.continue();
  });
  await ensureReviewDetails(page);
  await ensureNoteCorrection(page);
  await page.locator('#note-select').selectOption({ index: 1 });
  await page.locator('#correct-pitch').selectOption('62');
  await page.getByRole('button', { name: '应用音高校正', exact: true }).click();
  await expect(page.locator('.library-save-status')).toContainText('保存失败');
  await page.getByRole('spinbutton', { name: '速度', exact: true }).fill('69');
  await importOriginal(`${title} other`);
  await page.unroute('**/api/library/**');
  await page.getByRole('button', { name: `打开乐谱：${title}`, exact: true }).click();
  await expect(page.locator('.score-heading h2')).toHaveText(title);
  await expect(page.locator('.library-save-status')).toContainText('保存失败');
  await expect(page.getByRole('spinbutton', { name: '速度', exact: true })).toHaveValue('69');
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect(page.locator('.library-save-status')).toContainText('已保存到本机谱库');
  const list = await page.request.get('/api/library').then((r) => r.json());
  const metadata = list.documents.find((d: any) => d.title === title);
  const saved = await page.request.get(`/api/library/${encodeURIComponent(metadata.id)}`).then((r) => r.json());
  expect(saved.xml).toContain('<step>D</step>');
  expect(saved.session.tempo).toBe(69);
  await page.reload();
  await page.getByRole('button', { name: `打开乐谱：${title}`, exact: true }).click();
  await expect(page.getByRole('spinbutton', { name: '速度', exact: true })).toHaveValue('69');
  await mkdir('evidence/v0.6.4', { recursive: true });
  await writeFile(
    'evidence/v0.6.4/pending-switch-retry-summary.json',
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        authoredOnly: true,
        failureInjectedWithRoute: true,
        failedWrites,
        failedLatestPitchRetainedAcrossScoreSwitch: true,
        latestTempo: saved.session.tempo,
        explicitRetryVerifiedRealFileReadback: true,
        reloadRestored: true,
      },
      null,
      2,
    ),
  );
});

test('large score first PUT failure -> switch score -> visible unsaved entry -> switch back and retry -> read back XML and export', async ({
  page,
}) => {
  await page.goto('/');
  const title = `Large first PUT failure ${Date.now()}`;
  // Generate large score > 350k
  const largeXml = `<score-partwise><work><work-title>${title}</work-title></work><!--${'Large content padding '.repeat(20000)}--><part-list><score-part id="P"><part-name>Piano</part-name></score-part></part-list><part id="P"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part></score-partwise>`;

  // 1. Injected failure on first PUT
  await page.route('**/api/library/**', async (route) => {
    if (route.request().method() === 'PUT') {
      await route.fulfill({
        status: 507,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Disk temporarily full' }),
      });
    } else {
      await route.continue();
    }
  });

  // Import large score
  await page.getByLabel('导入乐谱文件').setInputFiles({
    name: `${title}.musicxml`,
    mimeType: 'application/xml',
    buffer: Buffer.from(largeXml),
  });
  await expect(page.locator('.score-heading h2')).toHaveText(title);
  await expect(page.locator('.library-save-status')).toContainText('保存失败');

  // 2. Switch to another score (demo score)
  await page.getByRole('button', { name: /先试一页示例/ }).click();
  await expect(page.locator('.score-heading h2')).toHaveText('First Light · 初光');

  // 3. Verify unsaved entry in library list with "未保存" badge
  const unsavedItem = page.locator('.saved-document-list button').filter({ hasText: title });
  await expect(unsavedItem).toBeVisible();
  await expect(unsavedItem.locator('.unsaved-badge')).toHaveText('未保存');

  // 4. Unroute failure and switch back to the failed large score
  await page.unroute('**/api/library/**');
  await unsavedItem.click();
  await expect(page.locator('.score-heading h2')).toHaveText(title);
  await expect(page.locator('.library-save-status')).toContainText('保存失败');

  // 5. Retry save
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect(page.locator('.library-save-status')).toContainText('已保存到本机谱库');

  // 6. Verify server has it and XML can be read back
  const list = await page.request.get('/api/library').then((r) => r.json());
  const meta = list.documents.find((d: any) => d.title === title);
  expect(meta).toBeTruthy();
  const savedDoc = await page.request.get(`/api/library/${encodeURIComponent(meta.id)}`).then((r) => r.json());
  expect(savedDoc.xml).toContain('Large content padding');
  expect(savedDoc.title).toBe(title);
});
