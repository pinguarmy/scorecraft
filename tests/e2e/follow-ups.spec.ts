import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from './helpers/test';
import { createAuthoredScoreXml } from './helpers/workspace';

async function openDemo(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: /先试一页示例/ }).click();
  await expect(page.locator('.score-heading h2')).toContainText('First Light');
  await expect(page.locator('.score-paper svg').first()).toBeVisible();
}

test('tempo and loop fields keep what is typed and settle it on Enter or leaving the field', async ({ page }) => {
  await openDemo(page);
  const tempo = page.getByRole('spinbutton', { name: '速度', exact: true });
  const paperMeta = page.locator('.paper-meta');
  await expect(tempo).toHaveValue('88');

  // Clearing the field and typing 1, 2, 0 must not snap to 30 on the way to 120.
  await tempo.click();
  await tempo.press('ControlOrMeta+a');
  await tempo.press('Backspace');
  await expect(tempo).toHaveValue('');
  await tempo.pressSequentially('1');
  await expect(tempo).toHaveValue('1');
  await expect(paperMeta).toContainText('88 BPM');
  await tempo.pressSequentially('20');
  await expect(tempo).toHaveValue('120');
  // A complete, valid value takes effect while typing (existing specs rely on fill() alone).
  await expect(paperMeta).toContainText('120 BPM');
  await tempo.press('Enter');
  await expect(tempo).toHaveValue('120');
  await expect(page.locator('#tempo-error')).toHaveCount(0);

  // Out of range: kept while typing, clamped with a hint on Enter.
  await tempo.fill('300');
  await expect(tempo).toHaveValue('300');
  await expect(paperMeta).toContainText('120 BPM');
  await tempo.press('Enter');
  await expect(tempo).toHaveValue('240');
  await expect(paperMeta).toContainText('240 BPM');
  await expect(page.getByRole('alert').filter({ hasText: '已改为 240' })).toBeVisible();
  await expect(tempo).toHaveAttribute('aria-invalid', 'true');

  // Cleared and left: the current value comes back.
  await tempo.fill('');
  await tempo.blur();
  await expect(tempo).toHaveValue('240');
  await expect(page.getByRole('alert').filter({ hasText: '已恢复为 240' })).toBeVisible();

  // Loop end below the start stays as typed until settled; it is not rewritten mid-typing.
  const start = page.getByRole('spinbutton', { name: '循环起始小节' });
  const end = page.getByRole('spinbutton', { name: '循环结束小节' });
  await start.fill('5');
  await expect(end).toHaveValue('5');
  await end.click();
  await end.press('ControlOrMeta+a');
  await end.pressSequentially('1');
  await expect(end).toHaveValue('1');
  await end.press('Enter');
  await expect(end).toHaveValue('5');
  await expect(page.locator('#loop-range-error')).toContainText('结束小节：请输入 5 至 8 的整数，已改为 5。');
  await end.press('ControlOrMeta+a');
  await end.pressSequentially('7');
  await expect(end).toHaveValue('7');
  await expect(page.locator('#loop-range-error')).toHaveCount(0);
  await page.getByRole('button', { name: '循环这几小节', exact: true }).click();
  await expect(page.locator('.practice-state')).toContainText('循环 5 至 7 小节');
});

test('scan retention text follows the period the server reports', async ({ page }) => {
  await page.route('**/api/jobs', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobs: [], retentionDays: 3 }),
    }),
  );
  await page.goto('/');
  await page.locator('.library-management > summary').click();
  await expect(page.locator('.library-management > p.micro-copy')).toContainText('扫描原稿另按 3 天保留');
  await page.locator('.about-panel > summary').click();
  await expect(page.locator('.about-panel')).toContainText('由扫描档案另保留 3 天');
  await expect(page.locator('.library')).not.toContainText('7 天');

  const title = `Retention Large ${randomUUID()}`;
  await page.getByLabel('导入乐谱文件').setInputFiles({
    name: `${title}.musicxml`,
    mimeType: 'application/xml',
    buffer: Buffer.from(createAuthoredScoreXml(title, { largePadding: true })),
  });
  await expect(page.locator('.score-heading h2')).toHaveText(title);
  await expect(page.locator('.library-save-status small')).toContainText('原始扫描另按 3 天保留');
});

test('a score reopened unchanged from the library does not claim to be saving', async ({ page }) => {
  await openDemo(page);
  const status = page.locator('.library-save-status > span');
  await expect(status).toHaveText('已保存到本机谱库');
  const id = await page.locator('.saved-document-list li:has(.recent-item.active)').getAttribute('data-document-id');
  expect(id).toBeTruthy();

  // Fresh page: no save state for this document yet. While the document is read from the
  // library, hold the browser outbox (IndexedDB) so the saver cannot report back.
  await page.reload();
  const documentPath = `/api/library/${encodeURIComponent(id!)}`;
  await page.route(
    (url) => url.pathname === documentPath,
    async (route) => {
      if (route.request().method() === 'GET') {
        await page.evaluate(
          () =>
            new Promise<void>((resolve, reject) => {
              const request = indexedDB.open('scorecraft-library-outbox', 1);
              request.onupgradeneeded = () => request.result.createObjectStore('pending-documents', { keyPath: 'id' });
              request.onerror = () => reject(request.error);
              request.onsuccess = () => {
                const store = request.result
                  .transaction('pending-documents', 'readonly')
                  .objectStore('pending-documents');
                const w = window as unknown as { releaseOutbox?: boolean };
                const spin = () => {
                  if (!w.releaseOutbox) store.count().onsuccess = spin;
                };
                spin();
                resolve();
              };
            }),
        );
      }
      await route.continue();
    },
  );
  await page.locator(`li[data-document-id="${id}"] button`).click();
  await expect(page.locator('.score-heading h2')).toContainText('First Light');
  await page.waitForTimeout(500);
  await expect(status).not.toHaveText('正在保存…');
  await expect(status).toHaveText('与本机谱库中的版本一致');
  await page.evaluate(() => {
    (window as unknown as { releaseOutbox?: boolean }).releaseOutbox = true;
  });
  await expect(status).toHaveText('已保存到本机谱库');
});

test('recognition that finishes after the window narrows opens the phone tools sheet', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const jobId = randomUUID();
  const title = `Narrowed During Recognition ${Date.now()}`;
  let finished = false;
  await page.route('**/api/health', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        engine: { available: true, name: 'Audiveris', version: 'mocked' },
        limits: { maxUploadBytes: 50 * 1024 * 1024 },
      }),
    }),
  );
  await page.route('**/api/jobs', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ jobs: [], retentionDays: 7 }),
    }),
  );
  await page.route('**/api/recognize', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: jobId }) }),
  );
  await page.route(`**/api/jobs/${jobId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        finished
          ? { id: jobId, status: 'done', resultUrl: `/api/jobs/${jobId}/score`, warnings: [] }
          : { id: jobId, status: 'running', message: '第 1 页' },
      ),
    }),
  );
  await page.route(`**/api/jobs/${jobId}/score`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.recordare.musicxml+xml',
      body: createAuthoredScoreXml(title, { measures: 4 }),
    }),
  );
  const health = page.waitForResponse((response) => response.url().endsWith('/api/health'));
  await page.goto('/');
  await health;
  await expect(page.locator('.engine-heading strong')).toHaveText('Audiveris 已就绪');

  await page.getByLabel('导入乐谱文件').setInputFiles({
    name: 'narrowed.png',
    mimeType: 'image/png',
    buffer: Buffer.from('mock image payload'),
  });
  await expect(page.locator('.job-status')).toContainText('Audiveris 正在识别');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: '当前练习', exact: true })).toBeVisible();
  finished = true;

  await expect(page.locator('.score-heading h2')).toHaveText(title);
  const sheet = page.locator('.inspector-settings[role="dialog"]');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('details.review-settings')).toHaveAttribute('open', '');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
});

test('the two dock buttons announce a dialog and open it where their labels say', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openDemo(page);
  const practiceButton = page.getByRole('button', { name: '当前练习', exact: true });
  const toolsButton = page.getByRole('button', { name: '工具', exact: true });
  for (const button of [practiceButton, toolsButton]) {
    await expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(button).toHaveAttribute('aria-controls', 'practice-tools');
    await expect(button).not.toHaveAttribute('aria-expanded', /.*/);
  }

  await toolsButton.click();
  const sheet = page.locator('#practice-tools[role="dialog"]');
  await expect(sheet).toBeVisible();
  // "工具" lands on the tool sections below the current practice, without choosing one of them.
  await expect(sheet.locator('details.sound-settings > summary')).toBeInViewport();
  await expect(sheet.locator('details.review-settings')).not.toHaveAttribute('open', '');
  await expect(sheet.locator('details.sound-settings')).not.toHaveAttribute('open', '');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(toolsButton).toBeFocused();

  await practiceButton.click();
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('#current-practice-title')).toBeInViewport();
});
