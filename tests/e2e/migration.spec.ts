import { test, expect } from './helpers/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

test('legacy recent scores migrate without erasing source data and failed imports keep the current context', async ({
  page,
}) => {
  const title = 'Legacy migration ' + Date.now();
  const xml = (await readFile('public/samples/first-light.musicxml', 'utf8')).replaceAll('First Light · 初光', title);
  const legacy = [
    {
      id: 'First Light · 初光:ScoreCraft contributors',
      title,
      xml,
      opened: Date.now() - 1000,
      source: 'legacy.musicxml',
    },
    { id: 'invalid', title: 'broken record', xml: 42 },
  ];
  await page.addInitScript(
    ({ recent, practice }) => {
      if (sessionStorage.getItem('migration-seeded')) return;
      localStorage.setItem('scorecraft.recent.v1', JSON.stringify(recent));
      localStorage.setItem('scorecraft.practice.v1', JSON.stringify(practice));
      sessionStorage.setItem('migration-seeded', 'yes');
    },
    { recent: legacy, practice: { tempo: 68, transpose: -2, metronome: true } },
  );
  await page.goto('/');
  const migratedBtn = page.getByRole('button', { name: '打开乐谱：' + title, exact: true });
  await expect(migratedBtn).toBeVisible();
  await expect(page.locator('.saved-document-list').getByText('broken record')).toHaveCount(0);
  await migratedBtn.click();
  await expect(page.locator('.score-heading h2')).toHaveText(title);
  await expect(page.getByRole('spinbutton', { name: '速度', exact: true })).toHaveValue('68');
  await expect(page.locator('#transpose')).toContainText('-2');
  const before = await page.evaluate(() => ({
    legacy: localStorage.getItem('scorecraft.recent.v1'),
    v2: localStorage.getItem('scorecraft.documents.v2'),
  }));
  expect(JSON.parse(before.legacy!).length).toBe(2);
  expect(JSON.parse(before.v2!).length).toBe(1);
  await page
    .getByLabel('导入乐谱文件')
    .setInputFiles({ name: 'not-a-real-image.png', mimeType: 'image/png', buffer: Buffer.from('not PNG data') });
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('.score-heading h2')).toHaveText(title);
  await expect(page.locator('.original-preview')).toHaveCount(0);
  await page.getByRole('button', { name: '关闭提示' }).click();
  await page.reload();
  await expect(migratedBtn).toBeVisible();
  await migratedBtn.click();
  await expect(page.getByRole('spinbutton', { name: '速度', exact: true })).toHaveValue('68');
  await mkdir('evidence/v0.2', { recursive: true });
  await writeFile(
    'evidence/v0.2/migration-summary.json',
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        validLegacyMigrated: 1,
        malformedLegacyIgnored: 1,
        originalV1Preserved: true,
        invalidImageDoesNotReplaceCurrentScoreOrOriginal: true,
      },
      null,
      2,
    ),
  );
});
