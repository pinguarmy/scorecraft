import { test, expect, type Page } from './helpers/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readScore } from '../../src/music/index';
import { ensureExportDetails } from './helpers/workspace';

const out = process.env.SCORECRAFT_EVIDENCE_DIR || 'evidence/v0.3';
async function openDemo(page: Page, repeat = false) {
  await page.goto('/');
  await page.getByRole('button', { name: repeat ? /试试反复练习示例/ : /先试一页示例/ }).click();
  await expect(page.locator('.score-heading h2')).toContainText(repeat ? 'Returning Steps' : 'First Light');
  await expect(page.locator('.score-paper svg').first()).toBeVisible();
}
async function audioClock(page: Page) {
  return page.evaluate(() => (window as any).__scorecraftAudio.contexts[0]?.currentTime ?? 0);
}
async function clockAfter(page: Page, at: number) {
  await expect.poll(() => audioClock(page), { timeout: 6000, intervals: [30, 40, 50] }).toBeGreaterThan(at);
}
async function events(page: Page) {
  return page.evaluate(() => (window as any).__scorecraftAudio.events as { id: number; type: string; frequency: number; scheduledAt: number; observedAt: number; stoppedAt: number | null }[]);
}
function parseMidi(data: Buffer) {
  expect(data.subarray(0, 4).toString()).toBe('MThd');
  const tracks = data.readUInt16BE(10); const ppq = data.readUInt16BE(12); let offset = 14;
  const result: { noteOns: { tick: number; pitch: number }[]; endTick: number; tempo?: number }[] = [];
  for (let t = 0; t < tracks; t++) {
    expect(data.subarray(offset, offset + 4).toString()).toBe('MTrk');
    const end = offset + 8 + data.readUInt32BE(offset + 4); let pos = offset + 8; let tick = 0; let running = 0;
    const track: { noteOns: { tick: number; pitch: number }[]; endTick: number; tempo?: number } = { noteOns: [], endTick: 0 };
    function variable() { let value = 0; let b; do { b = data[pos++]; value = value * 128 + (b & 127); } while (b & 128); return value; }
    while (pos < end) {
      tick += variable(); let status = data[pos++];
      if (status < 128) { pos--; status = running; } else if (status < 240) running = status;
      if (status === 255) { const type = data[pos++]; const length = variable(); if (type === 81) track.tempo = 60_000_000 / data.readUIntBE(pos, length); pos += length; }
      else if (status === 240 || status === 247) pos += variable();
      else { const kind = status & 240; const pitch = data[pos++]; if (kind !== 192 && kind !== 208) { const velocity = data[pos++]; if (kind === 144 && velocity) track.noteOns.push({ tick, pitch }); } }
    }
    expect(pos).toBe(end); track.endTick = tick; result.push(track); offset = end;
  }
  expect(offset).toBe(data.length); return { ppq, tracks: result };
}
async function saveDownload(page: Page, format: 'MIDI' | 'WAV' | 'MusicXML', name: string) {
  await ensureExportDetails(page);
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: new RegExp(`^${format}`) }).click();
  const download = await pending; const filename = download.suggestedFilename();
  await download.saveAs(`${out}/${name}`); return { filename, bytes: await readFile(`${out}/${name}`) };
}

test.beforeAll(async () => { await mkdir(out, { recursive: true }); });

test('selected measure exports rebase actual MIDI/WAV and preserve the whole XML', async ({ page }) => {
  await openDemo(page);
  await page.getByRole('spinbutton', { name: '速度', exact: true }).fill('120');
  await page.getByRole('button', { name: '升高半音', exact: true }).click();
  await page.getByRole('button', { name: '静音 Piano · 左手', exact: true }).click();
  await page.getByRole('spinbutton', { name: '循环结束小节' }).fill('4');
  await page.getByRole('spinbutton', { name: '循环起始小节' }).fill('3');
  await expect(page.getByRole('button', { name: '循环这几小节' })).toHaveAttribute('aria-pressed', 'false');
  await ensureExportDetails(page);
  await page.getByLabel('音频与 MIDI 导出范围').selectOption('excerpt');
  const midiFile = await saveDownload(page, 'MIDI', 'excerpt.mid');
  expect(midiFile.filename).toContain('小节-3-4');
  const midi = parseMidi(midiFile.bytes);
  expect(midi.ppq).toBe(480);
  expect(midi.tracks[0].tempo).toBeCloseTo(120, 3);
  expect(midi.tracks[1].noteOns).toEqual([{ tick: 0, pitch: 66 }, { tick: 480, pitch: 70 }, { tick: 960, pitch: 68 }, { tick: 1920, pitch: 63 }, { tick: 2400, pitch: 65 }, { tick: 2880, pitch: 68 }]);
  expect(midi.tracks[1].endTick).toBe(3840);
  expect(midi.tracks[2].noteOns).toHaveLength(0);
  expect(midi.tracks[2].endTick).toBe(3840);
  const excerpt = await saveDownload(page, 'WAV', 'excerpt.wav');
  expect(excerpt.filename).toContain('小节-3-4');
  const excerptSeconds = excerpt.bytes.readUInt32LE(40) / 2 / excerpt.bytes.readUInt16LE(22) / excerpt.bytes.readUInt32LE(24);
  expect(excerptSeconds).toBeCloseTo(4.5, 3);
  const xml = await saveDownload(page, 'MusicXML', 'whole.musicxml');
  const parsed = await readScore(xml.bytes);
  expect(parsed.measures).toHaveLength(8);
  await page.getByLabel('音频与 MIDI 导出范围').selectOption('full');
  const full = await saveDownload(page, 'WAV', 'full.wav');
  expect(full.filename).not.toContain('小节-3-4');
  const fullSeconds = full.bytes.readUInt32LE(40) / 2 / full.bytes.readUInt16LE(22) / full.bytes.readUInt32LE(24);
  expect(fullSeconds).toBeCloseTo(16.5, 3);
  await writeFile(`${out}/excerpt-summary.json`, JSON.stringify({ testedAt: new Date().toISOString(), range: [3, 4], manualLoopEnabled: false, tempo: 120, transpose: 1, leftHandMuted: true, midi, wavSeconds: { excerpt: excerptSeconds, full: fullSeconds }, xmlMeasureCount: parsed.measures.length, filenames: [midiFile.filename, excerpt.filename, xml.filename] }, null, 2));
});

test('real one-bar count-in holds cursor, hands off to music and persists without recounting loop wraps', async ({ page }) => {
  await page.addInitScript({ path: path.resolve('scripts/inspect-audio.mjs') });
  await openDemo(page);
  await page.getByRole('spinbutton', { name: '速度', exact: true }).fill('240');
  const toggle = page.getByRole('button', { name: '播放前预备一小节', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await page.getByRole('spinbutton', { name: '循环结束小节' }).fill('1');
  await page.getByRole('button', { name: '循环这几小节' }).click();
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.locator('.count-in-status.is-counting')).toBeVisible();
  const start = (await events(page))[0].scheduledAt;
  await clockAfter(page, start + .3);
  await expect(page.getByLabel('播放位置', { exact: true })).toHaveValue('0');
  const early = await events(page);
  expect(early.every(event => event.type === 'square')).toBeTruthy();
  await expect.poll(async () => (await events(page)).some(event => event.type === 'sample'), { timeout: 4000 }).toBeTruthy();
  await expect(page.locator('.count-in-status.is-counting')).toBeHidden();
  await clockAfter(page, start + 3.2);
  const all = await events(page);
  const clicks = all.filter(event => event.type === 'square');
  const firstMusic = all.find(event => event.type === 'sample')!;
  expect(clicks).toHaveLength(4);
  expect(firstMusic.scheduledAt - start).toBeGreaterThanOrEqual(.98);
  // The handoff runs on a browser timer; allow for a delayed main-thread tick.
  expect(firstMusic.scheduledAt - start).toBeLessThan(1.25);
  await expect.poll(async () => page.evaluate(() => (window as any).__scorecraftAudioRms())).toBeGreaterThan(.001);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.reload();
  await page.getByRole('button', { name: /^打开乐谱：First Light/ }).first().click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeVisible();
  await expect(page.locator('.count-in-status.is-counting')).toBeHidden();
  await page.screenshot({ path: `${out}/practice.png`, fullPage: true, style: '.skip-link{visibility:hidden!important}' });
  await writeFile(`${out}/count-in-summary.json`, JSON.stringify({ testedAt: new Date().toISOString(), expectedCountSeconds: 1, clickCountIncludingTwoLoopWraps: clicks.length, firstMusicDelay: firstMusic.scheduledAt - start, onlyClicksDuringInitialCount: true, cursorHeldAtZero: true, restoredTogglePaused: true, events: all }, null, 2));
});

test('exporting a repeated source range during count-in neither expands it nor modifies playback', async ({ page }) => {
  await page.addInitScript({ path: path.resolve('scripts/inspect-audio.mjs') });
  await openDemo(page, true);
  await page.getByRole('spinbutton', { name: '速度', exact: true }).fill('60');
  await page.getByRole('spinbutton', { name: '循环结束小节' }).fill('3');
  await page.getByRole('spinbutton', { name: '循环起始小节' }).fill('2');
  await ensureExportDetails(page);
  await page.getByLabel('音频与 MIDI 导出范围').selectOption('excerpt');
  const follows = page.getByRole('button', { name: '按谱面反复', exact: true });
  await expect(follows).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '播放前预备一小节', exact: true }).click();
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.locator('.count-in-status.is-counting')).toBeVisible();
  const excerpt = await saveDownload(page, 'MIDI', 'repeat-excerpt-during-count.mid');
  const clipped = parseMidi(excerpt.bytes);
  expect(clipped.tracks[1].noteOns).toEqual([{ tick: 0, pitch: 62 }, { tick: 1920, pitch: 64 }]);
  expect(clipped.tracks.every(track => track.endTick === 3840)).toBeTruthy();
  await expect(follows).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '循环这几小节' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.count-in-status.is-counting')).toBeVisible();
  await expect(page.getByLabel('播放位置', { exact: true })).toHaveValue('0');
  await page.getByRole('button', { name: '停止并回到开头' }).click();
  await ensureExportDetails(page);
  await page.getByLabel('音频与 MIDI 导出范围').selectOption('full');
  const full = parseMidi((await saveDownload(page, 'MIDI', 'repeat-full.mid')).bytes);
  expect(full.tracks[1].noteOns.map(note => note.pitch)).toEqual([60, 62, 64, 62, 64, 60]);
  expect(full.tracks[1].endTick).toBe(11520);
  const xml = await saveDownload(page, 'MusicXML', 'repeat-whole.musicxml');
  expect(xml.bytes.toString()).toContain('<repeat');
  expect((await readScore(xml.bytes)).measures).toHaveLength(4);
  await writeFile(`${out}/repeat-excerpt-summary.json`, JSON.stringify({ testedAt: new Date().toISOString(), range: [2, 3], excerpt: clipped, full, exportedDuringCount: true, countOrClickNotesInMidi: false, writtenRepeatAndManualLoopStateUnchanged: true, xmlStillWholeWithRepeatNotation: true }, null, 2));
});

test('pause stop and a real tempo edit cancel pending music beyond the old count-in deadline', async ({ page }) => {
  await page.addInitScript({ path: path.resolve('scripts/inspect-audio.mjs') });
  await openDemo(page);
  await page.getByRole('spinbutton', { name: '速度', exact: true }).fill('240');
  await page.getByRole('button', { name: '播放前预备一小节', exact: true }).click();
  const checks = [];
  for (const action of ['pause', 'stop', 'tempo']) {
    const before = (await events(page)).length;
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await expect(page.locator('.count-in-status.is-counting')).toBeVisible();
    const started = await audioClock(page);
    await clockAfter(page, started + .15);
    if (action === 'pause') await page.getByRole('button', { name: '暂停', exact: true }).click();
    if (action === 'stop') await page.getByRole('button', { name: '停止并回到开头', exact: true }).click();
    if (action === 'tempo') await page.getByRole('spinbutton', { name: '速度', exact: true }).fill('200');
    await expect(page.getByRole('button', { name: '播放', exact: true })).toBeVisible();
    await expect(page.locator('.count-in-status.is-counting')).toBeHidden();
    await expect(page.locator('.count-in-status')).toContainText('预备拍已取消');
    await clockAfter(page, started + 1.3);
    const after = (await events(page)).slice(before);
    expect(after.some(event => event.type === 'sample')).toBeFalsy();
    await expect(page.getByLabel('播放位置', { exact: true })).toHaveValue('0');
    checks.push({ action, scheduled: after, noLateMusic: true });
  }
  await writeFile(`${out}/count-cancel-summary.json`, JSON.stringify({ testedAt: new Date().toISOString(), checks }, null, 2));
});
