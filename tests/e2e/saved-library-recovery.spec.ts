import { test, expect } from './helpers/test';
import { ensureReviewDetails, ensureNoteCorrection } from './helpers/workspace';

const originalXml = (title: string, large = false) => {
  const padding = large ? `<!--${'Large authored padding '.repeat(20000)}-->` : '';
  return `<score-partwise><work><work-title>${title}</work-title></work>${padding}<part-list><score-part id="P"><part-name>Piano</part-name></score-part></part-list><part id="P"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type></note></measure></part></score-partwise>`;
};

test('A: delayed large score first PUT -> close/reload while in-flight -> IndexedDB outbox restores to UI as unsaved -> retry saves and reads back full XML', async ({
  browser,
}) => {
  const context = await browser.newContext();
  let page = await context.newPage();
  const title = `Delayed large score outbox reload ${Date.now()}`;
  const largeContent = originalXml(title, true);

  // 1. Intercept PUT to hold it in-flight indefinitely
  let releasePut!: () => void;
  const putHeld = new Promise<void>((resolve) => {
    releasePut = resolve;
  });
  let putStarted = false;

  await page.route('**/api/library/**', async (route) => {
    if (route.request().method() === 'PUT') {
      putStarted = true;
      await putHeld;
      await route.continue();
    } else {
      await route.continue();
    }
  });

  // 2. Import large score
  await page.goto('/');
  await page.getByLabel('导入乐谱文件').setInputFiles({
    name: `${title}.musicxml`,
    mimeType: 'application/xml',
    buffer: Buffer.from(largeContent),
  });
  await expect(page.locator('.score-heading h2')).toHaveText(title);

  // Wait until the save has been queued into outbox and PUT started
  await expect.poll(() => putStarted).toBe(true);

  // 3. Close the page while request is pending (simulating tab crash/close/reload before completion)
  await page.close();
  releasePut(); // Release intercepted route

  // 4. Open a new page in the same browser context (shares IndexedDB)
  page = await context.newPage();
  await page.goto('/');

  // 5. Verify the pending outbox entry was restored on hydration and displays in "已保存的谱" / "我的乐谱" with "未保存" badge
  const savedList = page.locator('.saved-document-list');
  await expect(savedList).toBeVisible();
  const unsavedButton = page.locator('.saved-document-list button').filter({ hasText: title });
  await expect(unsavedButton).toBeVisible();
  await expect(unsavedButton.locator('.unsaved-badge')).toHaveText('未保存');

  // 6. Click to open the recovered unsaved score
  await unsavedButton.click();
  await expect(page.locator('.score-heading h2')).toHaveText(title);
  await expect(page.locator('.library-save-status')).toContainText('保存失败');

  // 7. Click retry to persist
  await page.getByRole('button', { name: '重试保存', exact: true }).click();
  await expect(page.locator('.library-save-status')).toContainText('已保存到本机谱库');

  // 8. Verify on server that the score has been saved and full XML (>350k) is intact
  const list = await page.request.get('/api/library').then((r) => r.json());
  const meta = list.documents.find((d: any) => d.title === title);
  expect(meta).toBeTruthy();
  expect(meta.xmlBytes).toBeGreaterThan(350_000);

  const serverDoc = await page.request.get(`/api/library/${encodeURIComponent(meta.id)}`).then((r) => r.json());
  expect(serverDoc.xml).toContain('Large authored padding');
  expect(serverDoc.title).toBe(title);

  await context.close();
});

test('B: two tabs open same score -> Tab A edits and saves -> Tab B edits older version -> Tab B gets 409 conflict and Tab A is preserved', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const pageA = await context.newPage();
  const title = `Concurrency 409 protection ${Date.now()}`;
  const xml = originalXml(title, false);

  // 1. Tab A imports and saves initial score
  await pageA.goto('/');
  await pageA.getByLabel('导入乐谱文件').setInputFiles({
    name: `${title}.musicxml`,
    mimeType: 'application/xml',
    buffer: Buffer.from(xml),
  });
  await expect(pageA.locator('.score-heading h2')).toHaveText(title);
  await expect(pageA.locator('.library-save-status')).toContainText('已保存到本机谱库');

  const list = await pageA.request.get('/api/library').then((r) => r.json());
  const meta = list.documents.find((d: any) => d.title === title);
  expect(meta).toBeTruthy();

  // 2. Tab B opens the same saved score at version v1
  const pageB = await context.newPage();
  await pageB.goto('/');
  await pageB.getByRole('button', { name: `打开乐谱：${title}`, exact: true }).click();
  await expect(pageB.locator('.score-heading h2')).toHaveText(title);
  await expect(pageB.locator('.library-save-status')).toContainText('已保存到本机谱库');

  // 3. Tab A corrects pitch from C4 (60) to D4 (62) and saves to server v2
  await ensureReviewDetails(pageA);
  await ensureNoteCorrection(pageA);
  await pageA.locator('#note-select').selectOption({ index: 1 });
  await pageA.locator('#correct-pitch').selectOption('62');
  await pageA.getByRole('button', { name: '应用音高校正', exact: true }).click();
  await expect(pageA.locator('.library-save-status')).toContainText('已保存到本机谱库');

  // Verify server has Tab A's version with step D
  await expect
    .poll(async () => {
      const doc = await pageA.request.get(`/api/library/${encodeURIComponent(meta.id)}`).then((r) => r.json());
      return doc.xml.includes('<step>D</step>');
    })
    .toBe(true);

  // 4. Tab B (which still has base version before Tab A's edit) edits pitch from C4 (60) to E4 (64)
  await ensureReviewDetails(pageB);
  await ensureNoteCorrection(pageB);
  await pageB.locator('#note-select').selectOption({ index: 1 });
  await pageB.locator('#correct-pitch').selectOption('64');
  await pageB.getByRole('button', { name: '应用音高校正', exact: true }).click();

  // 5. Tab B MUST receive 409 conflict and display clear conflict state
  await expect(pageB.locator('.library-save-status')).toContainText('保存冲突');
  await expect(pageB.locator('.library-save-status')).toContainText('已被其他窗口更新');
  await expect(pageB.getByRole('button', { name: '覆盖保存', exact: true })).toBeVisible();

  // 6. Verify server STILL has Tab A's edit (D4), and was NOT overwritten by Tab B
  const serverDoc = await pageB.request.get(`/api/library/${encodeURIComponent(meta.id)}`).then((r) => r.json());
  expect(serverDoc.xml).toContain('<step>D</step>');
  expect(serverDoc.xml).not.toContain('<step>E</step>');

  await context.close();
});
