import { test, expect, type Page } from './helpers/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ensureSoundDetails, ensureExportDetails } from './helpers/workspace';

const output = 'evidence/v0.6';
const right = '声部乐器 Piano · 右手';
const left = '声部乐器 Piano · 左手';
const observed = (page: Page) => page.evaluate(() => (window as any).__scorecraftAudio.events as Array<{ type: string; scheduledAt: number; observedAt: number; offline?: boolean; channels?: number; duration?: number }>);
async function demo(page: Page): Promise<string> {
  const stamp = `<!-- Unique test run ${Date.now()}_${Math.random()} -->`;
  const baseXml = await readFile('public/samples/first-light.musicxml', 'utf8');
  const isolatedXml = baseXml.replace('<score-partwise', `${stamp}<score-partwise`);
  await page.route('**/samples/first-light.musicxml', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.recordare.musicxml+xml',
      body: isolatedXml,
    });
  });
  await page.addInitScript({ path: path.resolve('scripts/inspect-audio.mjs') });
  await page.goto('/');
  await page.getByRole('button', { name: /先试一页示例/ }).click();
  await expect(page.locator('.score-paper svg').first()).toBeVisible();
  const activeItem = page.locator('.saved-document-list li:has(button.active)');
  await expect(activeItem).toBeVisible();
  const docId = await activeItem.getAttribute('data-document-id');
  expect(docId).toBeTruthy();
  await ensureSoundDetails(page);
  await page.getByRole('button', { name: /^逐个调整音色/ }).click();
  return docId!;
}
async function download(page: Page, kind: 'MIDI' | 'WAV', filename: string) {
  await ensureExportDetails(page);
  const waiting = page.waitForEvent('download');
  await page.getByRole('button', { name: new RegExp(`^${kind}`) }).click();
  const result = await waiting; await result.saveAs(`${output}/${filename}`);
  return readFile(`${output}/${filename}`);
}
function midiEvents(bytes: Buffer) {
  expect(bytes.subarray(0, 4).toString()).toBe('MThd');
  let offset = 14;
  const programs: { channel: number; program: number }[] = [];
  const notes: { channel: number; pitch: number; tick: number }[] = [];
  while (offset < bytes.length) {
    expect(bytes.subarray(offset, offset + 4).toString()).toBe('MTrk');
    const end = offset + 8 + bytes.readUInt32BE(offset + 4); let position = offset + 8; let status = 0; let tick = 0;
    function variable() { let value = 0; let byte; do { byte = bytes[position++]; value = value * 128 + (byte & 127); } while (byte & 128); return value; }
    while (position < end) {
      tick += variable(); let next = bytes[position++]; if (next < 128) position--; else status = next;
      if (status === 255) { position++; const length = variable(); position += length; continue; }
      if (status === 240 || status === 247) { const length = variable(); position += length; continue; }
      const kind = status & 240; const channel = status & 15; const value = bytes[position++];
      if (kind === 192) programs.push({ channel, program: value });
      else if (kind !== 208) { const velocity = bytes[position++]; if (kind === 144 && velocity > 0) notes.push({ channel, pitch: value, tick }); }
    }
    expect(position).toBe(end); offset = end;
  }
  return { programs, notes };
}
function wavInfo(bytes: Buffer) {
  expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
  const channels = bytes.readUInt16LE(22); const sampleRate = bytes.readUInt32LE(24);
  let sum = 0; let peak = 0;
  for (let index = 44; index + 1 < bytes.length; index += 2) { const value = bytes.readInt16LE(index) / 32768; sum += value * value; peak = Math.max(peak, Math.abs(value)); }
  return { channels, sampleRate, seconds: bytes.readUInt32LE(40) / 2 / channels / sampleRate, rms: Math.sqrt(sum / ((bytes.length - 44) / 2)), peak, bytes: bytes.length };
}
test.beforeAll(async () => { await mkdir(output, { recursive: true }); });

test('two independently selected recorded instruments play together and export matching MIDI programs', async ({ page }) => {
  const sampleRequests: string[] = []; const external: string[] = [];
  page.on('request', request => { const url = new URL(request.url()); if (url.pathname.endsWith('.mp3')) sampleRequests.push(url.pathname); if (/^https?:/.test(url.protocol) && url.hostname !== '127.0.0.1') external.push(url.href); });
  const docId = await demo(page);
  await expect(page.getByLabel(right, { exact: true })).toHaveValue('piano-bright');
  await expect(page.getByLabel(right, { exact: true }).locator('option[value="drums"]')).toHaveAttribute('disabled', '');
  await page.getByLabel(right, { exact: true }).selectOption('guitar-acoustic');
  await page.getByLabel(left, { exact: true }).selectOption('bass-electric');
  await page.getByRole('spinbutton', { name: '速度', exact: true }).fill('120');
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible({ timeout: 20000 });
  await expect.poll(async () => (await observed(page)).filter(event => event.type === 'sample').length).toBeGreaterThanOrEqual(2);
  const live = await observed(page); const samples = live.filter(event => event.type === 'sample');
  // Scheduling is part-major, not chronological. Pair the two earliest actual onsets,
  // rather than assuming the first two created nodes belong to different parts.
  const onsets = [...samples].sort((a, b) => a.scheduledAt - b.scheduledAt);
  expect(Math.abs(onsets[0].scheduledAt - onsets[1].scheduledAt)).toBeLessThan(.05);
  expect(live.filter(event => event.type !== 'sample')).toEqual([]);
  await expect.poll(async () => page.evaluate(() => (window as any).__scorecraftAudioRms())).toBeGreaterThan(.0001);
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const midi = midiEvents(await download(page, 'MIDI', 'guitar-bass.mid'));
  expect(midi.programs.map(event => event.program)).toEqual(expect.arrayContaining([24, 33]));
  expect(midi.notes.filter(event => event.tick === 0).length).toBeGreaterThanOrEqual(2);
  const seg = page.locator('summary').filter({ hasText: /^分段练习/ });
  if (await seg.count() > 0 && await seg.locator('..').getAttribute('open') === null) await seg.click();
  await page.getByRole('spinbutton', { name: '循环结束小节' }).fill('2');
  await page.getByLabel('音频与 MIDI 导出范围').selectOption('excerpt');
  const wav = wavInfo(await download(page, 'WAV', 'mixed-demo.wav'));
  expect(wav.channels).toBe(2); expect(wav.sampleRate).toBe(44100); expect(wav.seconds).toBeCloseTo(4.5, 3); expect(wav.rms).toBeGreaterThan(.0001);
  expect(sampleRequests.some(url => url.includes('/guitar-acoustic/'))).toBeTruthy();
  expect(sampleRequests.some(url => url.includes('/bass-electric/'))).toBeTruthy();
  expect(sampleRequests.some(url => url.includes('/audio/piano/'))).toBeFalsy(); expect(external).toEqual([]);
  await page.reload();
  await page.locator(`.saved-document-list li[data-document-id="${docId}"] button`).click();
  await ensureSoundDetails(page);
  await page.getByRole('button', { name: /^逐个调整音色/ }).click();
  await expect(page.getByLabel(right, { exact: true })).toHaveValue('guitar-acoustic');
  await expect(page.getByLabel(left, { exact: true })).toHaveValue('bass-electric');
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeVisible();
  await writeFile(`${output}/guitar-bass-summary.json`, JSON.stringify({ testedAt: new Date().toISOString(), localSamplePaths: [...new Set(sampleRequests)], external, simultaneousVoices: onsets.slice(0, 2), midi, wav, restoredPerDocument: true, subjectiveListening: 'not claimed; recording sources and digital output checked' }, null, 2));
});

test('explicit synth selection pauses at the current position, produces oscillators and never changes the other part', async ({ page }) => {
  await demo(page);
  await page.getByLabel(right, { exact: true }).selectOption('guitar-electric');
  await page.getByLabel(left, { exact: true }).selectOption('strings');
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible({ timeout: 20000 });
  await expect.poll(async () => Number(await page.getByLabel('播放位置', { exact: true }).inputValue())).toBeGreaterThan(.2);
  await page.getByLabel(right, { exact: true }).selectOption('synth-pad');
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeVisible();
  const held = Number(await page.getByLabel('播放位置', { exact: true }).inputValue()); expect(held).toBeGreaterThan(0);
  await expect(page.getByLabel(left, { exact: true })).toHaveValue('strings');
  await expect(page.locator('.notice').filter({ hasText: '音色已更换' })).toBeVisible();
  const before = (await observed(page)).length;
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible();
  await expect.poll(async () => (await observed(page)).slice(before).some(event => event.type === 'triangle' || event.type === 'sine')).toBeTruthy();
  const after = (await observed(page)).slice(before);
  expect(after.some(event => event.type === 'sample')).toBeTruthy();
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  const midi = midiEvents(await download(page, 'MIDI', 'synth-strings.mid'));
  expect(midi.programs.map(event => event.program)).toEqual(expect.arrayContaining([89, 40]));
  await writeFile(`${output}/synth-summary.json`, JSON.stringify({ testedAt: new Date().toISOString(), heldPosition: held, explicitSynthAndSampleSources: after, midiPrograms: midi.programs, preservedOtherPart: true }, null, 2));
});

test('selected recording failure is visible, retries without fallback and slow loading can be cancelled', async ({ page }) => {
  let fail = true;
  await page.route('**/audio/instruments/guitar-acoustic/*.mp3', route => fail ? route.abort('failed') : route.continue());
  const docId = await demo(page);
  await page.getByLabel(right, { exact: true }).selectOption('guitar-acoustic');
  await page.getByLabel(left, { exact: true }).selectOption('synth-pad');
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.locator('.audio-status.error')).toBeVisible();
  expect(await observed(page)).toEqual([]);
  fail = false;
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.getByRole('button', { name: '暂停', exact: true })).toBeVisible({ timeout: 20000 });
  await page.getByRole('button', { name: '暂停', exact: true }).click();
  await page.unroute('**/audio/instruments/guitar-acoustic/*.mp3');
  await page.reload();
  await page.locator(`.saved-document-list li[data-document-id="${docId}"] button`).click();
  await ensureSoundDetails(page);
  await page.getByRole('button', { name: /^逐个调整音色/ }).click();
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/audio/instruments/guitar-acoustic/*.mp3', async route => { await gate; await route.continue(); });
  await page.getByRole('button', { name: '播放', exact: true }).click();
  await expect(page.getByRole('button', { name: /取消.*加载/ }).first()).toBeVisible();
  await page.getByRole('button', { name: '取消加载', exact: true }).click();
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeVisible();
  const loaded = page.waitForResponse(response => response.url().endsWith('/guitar-acoustic/D5.mp3'));
  release(); await loaded;
  expect(await observed(page)).toEqual([]);
  await expect(page.getByRole('button', { name: '播放', exact: true })).toBeVisible();
  await writeFile(`${output}/instrument-errors-summary.json`, JSON.stringify({ testedAt: new Date().toISOString(), selectedRecordingFailureVisible: true, noFallbackOrPartialSynthStart: true, retrySucceeded: true, cancelledLoadNeverStartedVoices: true }, null, 2));
});

const percussionXml = `<?xml version="1.0"?><score-partwise version="4.0"><work><work-title>Original percussion check</work-title></work><part-list><score-part id="G"><part-name>Guitar</part-name><score-instrument id="G-I"><instrument-name>Guitar</instrument-name></score-instrument><midi-instrument id="G-I"><midi-channel>1</midi-channel><midi-program>25</midi-program></midi-instrument></score-part><score-part id="D"><part-name>Drums</part-name><score-instrument id="D-K"><instrument-name>Kick</instrument-name></score-instrument><score-instrument id="D-S"><instrument-name>Snare</instrument-name></score-instrument><score-instrument id="D-H"><instrument-name>Hat</instrument-name></score-instrument><midi-instrument id="D-K"><midi-channel>10</midi-channel><midi-unpitched>37</midi-unpitched></midi-instrument><midi-instrument id="D-S"><midi-channel>10</midi-channel><midi-unpitched>39</midi-unpitched></midi-instrument><midi-instrument id="D-H"><midi-channel>10</midi-channel><midi-unpitched>43</midi-unpitched></midi-instrument></score-part></part-list><part id="G"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part><part id="D"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>percussion</sign></clef></attributes><note><unpitched><display-step>F</display-step><display-octave>4</display-octave></unpitched><duration>1</duration><instrument id="D-K"/><type>quarter</type></note><note><unpitched><display-step>C</display-step><display-octave>5</display-octave></unpitched><duration>1</duration><instrument id="D-S"/><type>quarter</type></note><note><unpitched><display-step>G</display-step><display-octave>5</display-octave></unpitched><duration>1</duration><instrument id="D-H"/><type>quarter</type></note><note><rest/><duration>1</duration><type>quarter</type></note></measure></part></score-partwise>`;

test('authored GM kick snare and hat mix with sampled guitar and export on percussion channel ten', async ({ page }) => {
  await page.addInitScript({ path: path.resolve('scripts/inspect-audio.mjs') });
  await page.goto('/');
  await page.getByLabel('导入乐谱文件').setInputFiles({ name: 'original-percussion.musicxml', mimeType: 'application/xml', buffer: Buffer.from(percussionXml) });
  await expect(page.locator('.score-source')).toHaveText('original-percussion.musicxml');
  await expect(page.locator('.score-paper svg').first()).toBeVisible();
  await ensureSoundDetails(page);
  await page.getByRole('button', { name: /^逐个调整音色/ }).click();
  const guitar = page.getByLabel(/声部乐器 Guitar/); const drums = page.getByLabel(/声部乐器 Drums/);
  await expect(guitar.locator('option[value="drums"]')).toHaveAttribute('disabled', '');
  await expect(drums.locator('option[value="drums"]')).not.toHaveAttribute('disabled', '');
  await guitar.selectOption('guitar-acoustic'); await drums.selectOption('drums');
  await page.getByRole('spinbutton', { name: '速度', exact: true }).fill('120');
  const midi = midiEvents(await download(page, 'MIDI', 'guitar-drums.mid'));
  expect(midi.notes.filter(event => event.channel === 9).map(event => event.pitch)).toEqual([36, 38, 42]);
  expect(midi.notes.some(event => event.channel !== 9 && event.pitch === 60)).toBeTruthy();
  expect(midi.programs.some(event => event.channel !== 9 && event.program === 24)).toBeTruthy();
  const wav = wavInfo(await download(page, 'WAV', 'guitar-drums.wav'));
  expect(wav.channels).toBe(2); expect(wav.sampleRate).toBe(44100); expect(wav.seconds).toBeCloseTo(2.5, 3); expect(wav.rms).toBeGreaterThan(.0001);
  const sources = await observed(page);
  expect(sources.some(event => event.type === 'sample')).toBeTruthy();
  expect(sources.some(event => event.type === 'sine')).toBeTruthy();
  await writeFile(`${output}/drums-summary.json`, JSON.stringify({ testedAt: new Date().toISOString(), originalFixture: true, explicitGmNotes: [36, 38, 42], melodicDrumOptionDisabled: true, midi, wav, hasSampleAndElectronicDrumSources: true }, null, 2));
});
