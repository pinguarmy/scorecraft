import { test, expect } from './helpers/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

// Verify effects in real browser audio/cursor rather than redoing scheduler unit mocks.
test('solo, silence, metronome and loop boundaries affect real playback', async ({ page }) => {
  await page.addInitScript({ path: path.resolve('scripts/inspect-audio.mjs') });
  await page.goto('/');
  await page.getByRole('button', { name: /先试一页示例/ }).click();
  await expect(page.locator('.score-heading h2')).toContainText('First Light');
  await page.getByRole('button', { name: '静音 Piano · 右手', exact: true }).click();
  await page.getByRole('button', { name: '静音 Piano · 左手', exact: true }).click();
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(async () => Number(await page.locator('#score-position').inputValue())).toBeGreaterThan(.2);
  const silentRms = await page.evaluate(() => (window as any).__scorecraftAudioRms());
  expect(silentRms).toBeLessThan(.00001);
  const metronome = page.getByRole('button', { name: /节拍器/ });
  await metronome.click();
  await expect.poll(async () => page.evaluate(() => (window as any).__scorecraftAudioRms()), { timeout: 5000, intervals: [50, 50, 100] }).toBeGreaterThan(.0001);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await metronome.click();
  await page.getByRole('button', { name: '独奏 Piano · 右手', exact: true }).click();
  await expect(page.getByRole('button', { name: '独奏 Piano · 右手', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '停止并回到开头' }).click();
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect.poll(async () => page.evaluate(() => (window as any).__scorecraftAudioRms())).toBeGreaterThan(.001);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.getByRole('spinbutton', { name: '速度', exact: true }).fill('240');
  await page.getByRole('spinbutton', { name: '循环起始小节' }).fill('2');
  await page.getByRole('spinbutton', { name: '循环结束小节' }).fill('2');
  await page.getByRole('button', { name: '循环这几小节' }).click();
  await page.getByRole('button', { name: '播放', exact: true }).click();
  const positions: number[] = [];
  let wraps = 0;
  await expect.poll(async () => {
    const value = Number(await page.locator('#score-position').inputValue());
    if (positions.length && value + 1 < positions.at(-1)!) wraps++;
    positions.push(value);
    return wraps;
  }, { timeout: 6000, intervals: [100, 100, 100] }).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  expect(positions.every(value => value >= 4 && value < 8.2)).toBeTruthy();
  await writeFile('evidence/practice-audio-summary.json', JSON.stringify({ testedAt: new Date().toISOString(), silentRms, metronomeProducesDigitalOutput: true, soloProducesDigitalOutput: true, loop: { startBeat: 4, endBeat: 8, wraps, observedPositions: positions } }, null, 2));
});
