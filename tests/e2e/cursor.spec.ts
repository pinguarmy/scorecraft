import { test, expect } from './helpers/test';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

// A visual inspection found a real renderer bug missed by transport-only checks.
test('actual OSMD iterator cursor follows restored position, metadata reload and repeat rewind', async ({ page }) => {
  await page.goto('/');
  const firstXml = (await readFile('public/samples/first-light.musicxml', 'utf8')).replace(
    '<score-partwise',
    '<!--cursor-' + Date.now() + '--><score-partwise',
  );
  await page
    .getByLabel('导入乐谱文件')
    .setInputFiles({ name: 'first-light.musicxml', mimeType: 'application/xml', buffer: Buffer.from(firstXml) });
  await expect(page.locator('.score-source')).toHaveText('first-light.musicxml');
  const slider = page.getByLabel('播放位置', { exact: true });
  await slider.evaluate((element) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, '17');
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const cursorHost = page.locator('.score-render-host');
  await expect(cursorHost).toHaveAttribute('data-source-measure', '5');
  await expect.poll(async () => Number(await cursorHost.getAttribute('data-source-beat'))).toBe(16);
  await page.getByRole('button', { name: '编辑曲名', exact: true }).click();
  await page.getByLabel('曲名', { exact: true }).fill('游标同步回归');
  await page.getByRole('button', { name: '保存曲名与作者', exact: true }).click();
  await expect(page.locator('.score-heading h2')).toHaveText('游标同步回归');
  await expect(cursorHost).toHaveAttribute('data-source-measure', '5');
  await page.reload();
  await page.getByRole('button', { name: '打开乐谱：游标同步回归', exact: true }).click();
  await expect(slider).toHaveValue('17');
  await expect(cursorHost).toHaveAttribute('data-source-measure', '5');
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await mkdir('evidence/v0.2', { recursive: true });
  await page.screenshot({
    path: 'evidence/v0.2/cursor-restored.png',
    fullPage: true,
    style: '.skip-link{visibility:hidden!important}',
  });
  const xml = (await readFile('public/samples/repeat-study.musicxml', 'utf8')).replace(
    '<score-partwise',
    '<!--repeat-cursor-' + Date.now() + '--><score-partwise',
  );
  await page
    .getByLabel('导入乐谱文件')
    .setInputFiles({ name: 'repeat-cursor.musicxml', mimeType: 'application/xml', buffer: Buffer.from(xml) });
  await expect(page.locator('.score-source')).toHaveText('repeat-cursor.musicxml');
  await page.getByRole('spinbutton', { name: '速度', exact: true }).fill('240');
  await page.getByRole('button', { name: '播放', exact: true }).click();
  let prior = 0;
  let rewound = false;
  await expect
    .poll(
      async () => {
        const current = Number(await slider.inputValue());
        if (prior - current > 1) rewound = true;
        prior = current;
        return rewound;
      },
      { timeout: 10000, intervals: [70] },
    )
    .toBeTruthy();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await expect(cursorHost).toHaveAttribute('data-source-measure', '2');
  await expect(cursorHost).toHaveAttribute('data-source-beat', '4');
  await writeFile(
    'evidence/v0.2/cursor-summary.json',
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        sourceBeat17: {
          actualIteratorBeat: 16,
          actualIteratorMeasure: 5,
          reason: 'Nearest notated onset is beat16, a half note sustaining across beat17',
        },
        survivedMetadataReloadAndPageReload: true,
        repeatRewind: { actualIteratorBeat: 4, actualIteratorMeasure: 2 },
      },
      null,
      2,
    ),
  );
});
