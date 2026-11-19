import { test, expect } from './helpers/test';
import { randomUUID } from 'node:crypto';
import {
  createAuthoredScoreXml,
  ensureSoundDetails,
  ensureReviewDetails,
  ensureExportDetails,
  openMobileSheet,
  closeMobileSheet,
} from './helpers/workspace';

test.describe('Workspace Flow - Task-oriented reorganization (2026-11-03)', () => {
  test('1440 desktop: direct discoverability of core practice, sound folded, deduplicated library, single inputs', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const title = `Desk Practice Flow ${Date.now()}`;
    const xml = createAuthoredScoreXml(title, {
      measures: 8,
      parts: [
        { id: 'P1', name: 'Piano Right' },
        { id: 'P2', name: 'Piano Left' },
      ],
    });

    await page.goto('/');

    // 1. Import authored unique score
    await page.getByLabel('导入乐谱文件').setInputFiles({
      name: `${title}.musicxml`,
      mimeType: 'application/xml',
      buffer: Buffer.from(xml),
    });
    await expect(page.locator('.score-heading h2')).toHaveText(title);

    // 2. Left side: '我的乐谱' list deduplication & stable IDs
    const libraryList = page.locator('.saved-document-list');
    await expect(libraryList).toBeVisible();
    const docItems = libraryList.locator('li[data-document-id]');
    await expect(docItems.first()).toBeVisible();

    // Verify deduplication: exactly 1 li for this document
    const matchingDocs = libraryList.locator(`li:has(button[aria-label="打开乐谱：${title}"])`);
    await expect(matchingDocs).toHaveCount(1);
    const docId = await matchingDocs.getAttribute('data-document-id');
    expect(docId).toBeTruthy();

    // Verify button aria-label format
    const openBtn = matchingDocs.getByRole('button', { name: `打开乐谱：${title}`, exact: true });
    await expect(openBtn).toBeVisible();

    // 3. Secondary library management container exists with summary '谱库管理与导入帮助'
    const libMgmt = page.locator('.library-management');
    await expect(libMgmt).toBeVisible();
    await expect(libMgmt.locator(':scope > summary')).toContainText('谱库管理与导入帮助');

    // 4. Right side: #current-practice contains high-frequency practice controls
    const practicePanel = page.locator('#current-practice.current-practice');
    await expect(practicePanel).toBeVisible();

    // Loop toggle and loop start/end
    const loopToggle = practicePanel.getByRole('button', { name: '循环这几小节' });
    await expect(loopToggle).toBeVisible();
    await expect(practicePanel.getByLabel('循环起始小节')).toBeVisible();
    await expect(practicePanel.getByLabel('循环结束小节')).toBeVisible();

    // Quick 4-bar practice
    const quick4Btn = practicePanel.getByRole('button', { name: /从当前小节练4小节|练当前4小节/ });
    await expect(quick4Btn).toBeVisible();
    await quick4Btn.click();
    await expect(practicePanel.getByLabel('循环起始小节')).toHaveValue('1');
    await expect(practicePanel.getByLabel('循环结束小节')).toHaveValue('4');
    await expect(loopToggle).toHaveAttribute('aria-pressed', 'true');

    // Tempo presets: fixture defaults to 100 BPM base tempo -> 75% is 75 BPM, 100% recovers 100 BPM
    const tempo75 = practicePanel.getByRole('button', { name: /75%/ });
    const tempo100 = practicePanel.getByRole('button', { name: '恢复基准速度', exact: true });
    await expect(tempo75).toBeVisible();
    await expect(tempo100).toBeVisible();
    await tempo75.click();
    const tempoInput = page.locator('#tempo');
    await expect(tempoInput).toBeVisible();
    await expect(tempoInput).toHaveValue('75');

    await tempo100.click();
    await expect(tempoInput).toHaveValue('100');

    // Transpose in #current-practice
    const raiseBtn = practicePanel.getByRole('button', { name: '升高半音' });
    await expect(raiseBtn).toBeVisible();
    await raiseBtn.click();
    await expect(practicePanel.locator('#transpose')).toContainText('+1');

    // Metronome & Count-in in #current-practice
    const metronomeBtn = practicePanel.getByRole('button', { name: /节拍器/ });
    await expect(metronomeBtn).toBeVisible();
    const countInToggle = practicePanel.getByRole('button', { name: '播放前预备一小节' });
    await expect(countInToggle).toBeVisible();

    // Voice Solo & Mute directly visible in practice panel
    await expect(practicePanel).toContainText('只听');
    await expect(practicePanel).toContainText('静音');
    const soloBtn = practicePanel.getByRole('button', { name: /独奏 Piano Right/ });
    await expect(soloBtn).toBeVisible();
    await soloBtn.click();
    await expect(soloBtn).toHaveAttribute('aria-pressed', 'true');

    // 5. Sound controls folded under details.sound-settings
    const soundDetails = page.locator('details.sound-settings');
    await expect(soundDetails).toBeVisible();
    await expect(soundDetails).not.toHaveAttribute('open', '');
    await ensureSoundDetails(page);
    await expect(soundDetails.getByLabel('整首配器', { exact: true })).toBeVisible();

    // 6. Review & Export details
    const reviewDetails = page.locator('details.review-settings');
    await expect(reviewDetails).toBeVisible();
    await expect(reviewDetails).not.toHaveAttribute('open', '');

    const exportDetails = page.locator('details.export-settings');
    await expect(exportDetails).toBeVisible();
    await expect(exportDetails).not.toHaveAttribute('open', '');

    // Score header '校对与原稿' entrance opens review-settings
    const reviewHeaderBtn = page.getByRole('button', { name: /校对与原稿/ });
    await expect(reviewHeaderBtn).toBeVisible();
    await reviewHeaderBtn.click();
    await expect(reviewDetails).toHaveAttribute('open', '');
    await expect(reviewDetails.locator('#note-select')).toBeVisible();

    // 7. Verify no duplicate controls / IDs
    expect(await page.locator('#tempo').count()).toBe(1);
    expect(await page.locator('#score-position').count()).toBe(1);
    expect(await page.locator('#arrangement-preset').count()).toBe(1);
  });

  test('failed snapshot entrance in unified list with unsaved badge and error recovery', async ({ page }) => {
    const title = `Failed Outbox Entrance ${Date.now()}`;
    const xml = createAuthoredScoreXml(title, { measures: 4 });

    // Injected storage failure
    await page.route('**/api/library/**', async route => {
      if (['PUT', 'PATCH'].includes(route.request().method())) {
        await route.fulfill({ status: 507, contentType: 'application/json', body: JSON.stringify({ message: 'Disk space error' }) });
      } else {
        await route.continue();
      }
    });

    await page.goto('/');
    await page.getByLabel('导入乐谱文件').setInputFiles({
      name: `${title}.musicxml`,
      mimeType: 'application/xml',
      buffer: Buffer.from(xml),
    });

    await expect(page.locator('.score-heading h2')).toHaveText(title);
    await expect(page.locator('.library-save-status')).toContainText('保存失败');

    // Switch away to demo score
    await page.getByRole('button', { name: /先试一页示例/ }).click();
    await expect(page.locator('.score-heading h2')).toHaveText(/First Light/);

    // Verify unified list .saved-document-list shows failed snapshot with badge
    const failedItem = page.locator('.saved-document-list li').filter({ hasText: title });
    await expect(failedItem).toBeVisible();
    await expect(failedItem.locator('.unsaved-badge')).toHaveText('未保存');

    // Click to open failed score
    await page.unroute('**/api/library/**');
    await failedItem.getByRole('button', { name: `打开乐谱：${title}`, exact: true }).click();
    await expect(page.locator('.score-heading h2')).toHaveText(title);
    await expect(page.locator('.library-save-status')).toContainText('保存失败');

    // Retry and verify save
    await page.getByRole('button', { name: '重试保存', exact: true }).click();
    await expect(page.locator('.library-save-status')).toContainText('已保存到本机谱库');

    // Verify on server
    const list = await page.request.get('/api/library').then(r => r.json());
    const savedDoc = list.documents?.find((d: any) => d.title === title);
    expect(savedDoc).toBeTruthy();
  });

  test('390 mobile: single transport dock, sheet open/close/Escape/focus trap & return, no horizontal overflow, state retained', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const title = `Mobile Dock Flow ${Date.now()}`;
    const xml = createAuthoredScoreXml(title, { measures: 6 });

    await page.goto('/');
    await page.getByLabel('导入乐谱文件').setInputFiles({
      name: `${title}.musicxml`,
      mimeType: 'application/xml',
      buffer: Buffer.from(xml),
    });
    await expect(page.locator('.score-heading h2')).toHaveText(title);

    // 1. Single transport dock visible at viewport bottom
    const dock = page.locator('section.transport');
    await expect(dock).toBeVisible();
    expect(await page.locator('section.transport').count()).toBe(1);

    // Verify dock height (44px <= height <= 145px) and bounding box
    const dockBox = await dock.boundingBox();
    expect(dockBox).toBeTruthy();
    expect(dockBox!.height).toBeGreaterThanOrEqual(44);
    expect(dockBox!.height).toBeLessThanOrEqual(145);
    expect(dockBox!.y + dockBox!.height).toBeGreaterThanOrEqual(840);

    // Verify dock triggers are in viewport
    const triggerPractice = dock.getByRole('button', { name: '当前练习', exact: true });
    const triggerReview = dock.getByRole('button', { name: '工具', exact: true });
    await expect(triggerPractice).toBeInViewport();
    await expect(triggerReview).toBeInViewport();

    // Verify no horizontal overflow initially
    const overflow = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(overflow.document).toBeLessThanOrEqual(overflow.viewport + 1);

    // 2. Perform seek BEFORE opening sheet
    await page.locator('#score-position').fill('4');
    const positionVal = await page.locator('#score-position').inputValue();

    // 3. Open sheet via '当前练习'
    await triggerPractice.focus();
    const dialog = await openMobileSheet(page, '当前练习');
    await expect(dialog).toBeVisible();

    // Verify backdrop is present and modal is non-penetrable (score-position ancestor has inert, focus cannot penetrate)
    const backdrop = page.locator('.mobile-tools-backdrop');
    await expect(backdrop).toBeVisible();
    const sliderInert = await page.evaluate(() => {
      const slider = document.querySelector<HTMLInputElement>('#score-position');
      if (!slider) return false;
      const inertAncestor = slider.closest('[inert]');
      slider.focus();
      const cannotFocus = document.activeElement !== slider;
      return inertAncestor !== null && cannotFocus;
    });
    expect(sliderInert).toBe(true);

    // Verify #current-practice is inside dialog
    const practiceInDialog = dialog.locator('#current-practice');
    await expect(practiceInDialog).toBeVisible();

    // Change transpose inside dialog
    await practiceInDialog.getByRole('button', { name: '升高半音' }).click();
    await expect(practiceInDialog.locator('#transpose')).toContainText('+1');

    // 4. Verify focus trap inside sheet with Tab
    await page.keyboard.press('Tab');
    const insideActive = await page.evaluate(() => {
      const active = document.activeElement;
      const dialogEl = document.querySelector('.inspector-settings[role="dialog"]');
      return dialogEl?.contains(active);
    });
    expect(insideActive).toBe(true);
    const close = page.getByRole('button', { name: '关闭练习工具', exact: true });
    await close.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(dialog.locator('.export-settings > summary')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(close).toBeFocused();

    // 5. Close sheet with Escape and verify focus returns to triggerPractice
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(triggerPractice).toBeFocused();

    // 6. Verify score, tempo, position were NOT lost after closing sheet
    await expect(page.locator('.score-heading h2')).toHaveText(title);
    expect(await page.locator('#score-position').inputValue()).toBe(positionVal);
    await expect(page.locator('.practice-state')).toContainText('+1');

    // 7. Open sheet via '工具'
    await triggerReview.focus();
    await openMobileSheet(page, '工具');
    await expect(dialog).toBeVisible();

    // Verify review and export can be reached in sheet
    await ensureReviewDetails(page);
    await expect(dialog.locator('details.review-settings')).toHaveAttribute('open', '');
    await expect(dialog.locator('#note-select')).toBeVisible();

    await ensureExportDetails(page);
    await expect(dialog.locator('details.export-settings')).toHaveAttribute('open', '');

    // 8. Close sheet via close button '关闭练习工具' and verify focus returns to triggerReview
    await closeMobileSheet(page, false);
    await expect(dialog).toBeHidden();
    await expect(triggerReview).toBeFocused();

    // Still no horizontal overflow after interactions
    const afterOverflow = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
    }));
    expect(afterOverflow.document).toBeLessThanOrEqual(afterOverflow.viewport + 1);
  });

  test('authored mocked recognition: completion automatically opens review details and presents original sheet entrance', async ({ page }) => {
    // Authored mocked recognition flow (not genuine OMR, explicitly mocked route)
    const mockJobId = randomUUID();
    const mockTitle = `Authored Mocked Scan Flow ${Date.now()}`;
    const mockXml = createAuthoredScoreXml(mockTitle, { measures: 4 });

    // Mock health GET so importFile authorizes recognition upload in this test
    await page.route('**/api/health', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          engine: { available: true, name: 'Audiveris', version: 'mocked-5.6' },
          limits: { maxUploadBytes: 50 * 1024 * 1024 },
        }),
      });
    });

    // Mock recognize POST
    await page.route('**/api/recognize', async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ id: mockJobId, reused: false }),
      });
    });

    // Mock job polling GET
    await page.route(`**/api/jobs/${mockJobId}`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: mockJobId,
          status: 'done',
          resultUrl: `/api/jobs/${mockJobId}/score`,
          warnings: ['Authored scan check warning'],
        }),
      });
    });

    // Mock score MusicXML GET
    await page.route(`**/api/jobs/${mockJobId}/score`, async route => {
      await route.fulfill({
        status: 200,
        contentType: 'application/vnd.recordare.musicxml+xml',
        body: mockXml,
      });
    });

    // Mock original image GET
    await page.route(`**/api/jobs/${mockJobId}/original`, async route => {
      const gif1x1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
      await route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: gif1x1,
      });
    });

    await page.route('**/api/jobs', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jobs: [{ id: mockJobId, status: 'done', originalName: 'mock-sheet.png', createdAt: new Date().toISOString() }], retentionDays: 7 }) }));
    const healthResponse = page.waitForResponse(response => response.url().endsWith('/api/health'));
    await page.goto('/');
    await healthResponse;
    await expect(page.locator('.engine-heading strong')).toHaveText('Audiveris 已就绪');

    // Upload dummy image to trigger mocked recognition
    await page.getByLabel('导入乐谱文件').setInputFiles({
      name: 'mock-sheet.png',
      mimeType: 'image/png',
      buffer: Buffer.from('mock image payload'),
    });

    // Verify score loaded
    await expect(page.locator('.score-heading h2')).toHaveText(mockTitle);

    // Verify completion actively presents review entrance and review details is automatically opened
    const reviewDetails = page.locator('details.review-settings');
    await expect(reviewDetails).toBeVisible();
    await expect(reviewDetails).toHaveAttribute('open', '');

    // Verify original sheet comparison entrance
    const originalEntrance = page.locator('.review-intro button, .review-notice button').filter({ hasText: /查看原稿/ });
    await expect(originalEntrance.first()).toBeVisible();

    // Recognition warnings remain available in the consolidated review section.
    await expect(reviewDetails).toContainText('Authored scan check warning');
  });
});
