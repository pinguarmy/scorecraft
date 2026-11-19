import { test, expect, type Page } from './helpers/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { ensureReviewDetails, ensureNoteCorrection, ensureExportDetails } from './helpers/workspace';
const out = 'evidence/v0.6.4';
const stamp = `Original library ${Date.now()}`;
function originalXml(title: string, large = false, tiedChord = false) {
  const padding = large ? `<!--${'Original authored spacing '.repeat(20000)}-->` : '';
  const note = (step: string, chord: boolean, tie: string) => `<note>${chord ? '<chord/>' : ''}<pitch><step>${step}</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><type>whole</type>${tie ? `<tie type="${tie}"/><notations><tied type="${tie}"/></notations>` : ''}</note>`;
  return `<?xml version="1.0"?><score-partwise><work><work-title>${title}</work-title></work>${padding}<part-list><score-part id="P"><part-name>Piano</part-name></score-part></part-list><part id="P"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>${note('C', false, tiedChord ? 'start' : '')}${tiedChord ? note('E', true, 'start') : ''}</measure><measure number="2">${note('C', false, tiedChord ? 'stop' : '')}${tiedChord ? note('E', true, 'stop') : ''}</measure></part></score-partwise>`;
}
async function openDetails(page: Page, name: string) {
  if (name.includes('音符校正') || name.includes('识谱')) {
    await ensureReviewDetails(page);
    await ensureNoteCorrection(page);
    return;
  }
  if (name.includes('导出')) {
    await ensureExportDetails(page);
    return;
  }
  const summary = page.locator('summary').filter({ hasText: new RegExp(`^${name}`) }).first();
  if (await summary.count() > 0) {
    if (await summary.locator('..').getAttribute('open') === null) await summary.click();
  }
}
async function importXml(page: Page, title: string, large = false, tiedChord = false) {
  await page.getByLabel('导入乐谱文件').setInputFiles({ name: `${title}.musicxml`, mimeType: 'application/xml', buffer: Buffer.from(originalXml(title, large, tiedChord)) });
  await expect(page.locator('.score-heading h2')).toHaveText(title);
  await expect(page.locator('.score-paper svg').first()).toBeVisible();
}
async function saved(page: Page, title: string) {
  await expect.poll(async () => { const response = await page.request.get('/api/library'); const data = await response.json(); return data.documents?.some((d: any) => d.title === title); }).toBe(true);
}
test.beforeAll(async () => { await mkdir(out, { recursive: true }); });

test('large corrected chord score and practice settings survive closing, reopening and recent-history eviction', async ({ browser }) => {
  const context = await browser.newContext(); let page = await context.newPage();
  try {
    await page.goto('/');
    const title = `${stamp} large`;
    await importXml(page, title, true, true);
    await saved(page, title);
    await openDetails(page, '音符校正');
    await page.locator('#note-select').selectOption({ index: 1 });
    await page.locator('#correct-pitch').selectOption('62');
    await page.getByRole('button', { name: '应用音高校正', exact: true }).click();
    await expect(page.locator('.desk > .notice')).toContainText('已将');
    await page.getByRole('spinbutton', { name: '速度', exact: true }).fill('72');
    await openDetails(page, '分段练习');
    await page.getByLabel('循环结束小节', { exact: true }).fill('2');
    await page.getByRole('button', { name: '循环这几小节', exact: true }).click();
    await page.getByLabel('跟谱方式', { exact: true }).selectOption('page');
    await page.getByRole('button', { name: '自动跟谱', exact: true }).click();
    const find = async () => { const data = await page.request.get('/api/library').then(r => r.json()); return data.documents.find((d: any) => d.title === title); };
    const meta = await find(); expect(meta.xmlBytes).toBeGreaterThan(350000);
    await expect.poll(async () => { const doc = await page.request.get(`/api/library/${encodeURIComponent(meta.id)}`).then(r => r.json()); return { tempo: doc.session.tempo, loop: doc.session.loop, mode: doc.session.followMode, enabled: doc.session.followEnabled, corrected: doc.xml.includes('<step>D</step>') }; }).toEqual({ tempo: 72, loop: true, mode: 'page', enabled: false, corrected: true });
    await page.close(); page = await context.newPage(); await page.goto('/');
    await page.getByRole('button', { name: `打开乐谱：${title}`, exact: true }).click();
    await expect(page.locator('.score-heading h2')).toHaveText(title);
    await expect(page.getByRole('spinbutton', { name: '速度', exact: true })).toHaveValue('72');
    await expect(page.getByLabel('跟谱方式', { exact: true })).toHaveValue('page');
    await expect(page.getByRole('button', { name: '自动跟谱', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('button', { name: '播放', exact: true })).toBeVisible();
    await openDetails(page, '导出乐谱与音频');
    const pending = page.waitForEvent('download'); await page.getByRole('button', { name: /^MusicXML/ }).click();
    const file = await pending; const destination = `${out}/corrected-original-chord.musicxml`; await file.saveAs(destination);
    const exported = await readFile(destination, 'utf8'); expect((exported.match(/<step>D<\/step>/g) || []).length).toBe(2); expect((exported.match(/<step>E<\/step>/g) || []).length).toBe(2);
    for (let i = 0; i < 5; i++) { const other = `${stamp} study ${i}`; await importXml(page, other); await saved(page, other); }
    const after = await page.request.get('/api/library').then(r => r.json()); expect(after.documents.some((d: any) => d.id === meta.id)).toBe(true);
    expect(after.documents.filter((d: any) => d.title.startsWith(stamp)).length).toBe(6);

    // Open library management to clear browser cache
    const mgmt = page.locator('.library-management');
    const summary = mgmt.locator(':scope > summary');
    await expect(summary).toBeVisible();
    const isOpen = await mgmt.evaluate((el: HTMLElement) => el.hasAttribute('open'));
    if (!isOpen) await summary.click();

    const clearBtn = page.getByRole('button', { name: /清除本地历史|清除缓存|清空历史/ });
    await expect(clearBtn).toBeVisible();
    await clearBtn.click();
    // Verify browser cache key in localStorage is cleared
    await expect.poll(async () => {
      return page.evaluate(() => {
        const d = localStorage.getItem('scorecraft.documents.v1') || localStorage.getItem('scorecraft.recent.v1');
        return d === null || d === '[]' || d === '';
      });
    }).toBe(true);

    // Verify unified list still has saved scores intact
    await expect(page.locator('.saved-document-list li')).not.toHaveCount(0);
    await page.reload();
    await page.getByRole('button', { name: `打开乐谱：${title}`, exact: true }).click();
    await expect(page.getByRole('spinbutton', { name: '速度', exact: true })).toHaveValue('72');
    await writeFile(`${out}/library-browser-summary.json`, JSON.stringify({ testedAt: new Date().toISOString(), authoredMusicOnly: true, xmlBytes: meta.xmlBytes, closedAndReopened: true, correctedChordBothSegmentsRetained: true, independentSavedDocuments: 6, recentEvictionAndClearDoNotDeleteSavedScore: true, tempoLoopFollowRestoredPaused: true }, null, 2));
  } finally { await context.close(); }
});
