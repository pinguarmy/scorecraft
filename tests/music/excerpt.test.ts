import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { excerptScore } from '../../src/music/excerpt';
import { exportMidi, scoreToWav } from '../../src/music/export';
import { readScore } from '../../src/music/index';
import type { Score, ScoreNote } from '../../src/music/types';
import { after } from 'node:test';
import { installTestOfflinePcm } from './helpers/offline-pcm';
const restoreOfflinePcm = installTestOfflinePcm();
after(restoreOfflinePcm);

const makeNote = (id: string, beat: number, duration: number, midi: number, partId = 'right'): ScoreNote => ({
  id,
  partId,
  beat,
  duration,
  midi,
  velocity: 80,
  measure: Math.floor(beat / 4) + 1,
});
function fixture(): Score {
  return {
    title: 'Boundary study',
    composer: 'ScoreCraft',
    tempo: 120,
    beatsPerMeasure: 4,
    totalBeats: 16,
    xml: '<source-notation/>',
    warnings: [],
    measures: [0, 4, 8, 12].map((startBeat, i) => ({ number: 10 + i, startBeat, duration: 4 })),
    parts: [
      {
        id: 'right',
        name: 'Right',
        instrument: 4,
        notes: [
          makeNote('before', 0, 4, 59),
          { ...makeNote('left-crossing-tie', 2, 4, 60), tie: 'merged' },
          makeNote('inside', 4, 1, 62),
          makeNote('right-crossing', 10, 4, 64),
          makeNote('at-end', 12, 1, 65),
        ],
      },
      { id: 'left', name: 'Left', instrument: 0, notes: [makeNote('bass', 4, 8, 48, 'left')] },
      { id: 'empty', name: 'Rest', instrument: 0, notes: [] },
    ],
    playback: {
      segments: [
        { sourceStart: 0, sourceEnd: 16, playStart: 0 },
        { sourceStart: 0, sourceEnd: 16, playStart: 16 },
      ],
      totalBeats: 32,
      expanded: true,
    },
  };
}
function midiEvents(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const events: { track: number; tick: number; status: number; meta?: number; data: number[] }[] = [];
  let offset = 14;
  const variable = () => {
    let n = 0;
    let byte;
    do {
      byte = bytes[offset++];
      n = n * 128 + (byte & 127);
    } while (byte & 128);
    return n;
  };
  for (let track = 0; track < view.getUint16(10); track++) {
    assert.equal(new TextDecoder().decode(bytes.subarray(offset, offset + 4)), 'MTrk');
    const end = offset + 8 + view.getUint32(offset + 4);
    offset += 8;
    let tick = 0;
    while (offset < end) {
      tick += variable();
      const status = bytes[offset++];
      if (status === 0xff) {
        const meta = bytes[offset++];
        const length = variable();
        events.push({ track, tick, status, meta, data: Array.from(bytes.subarray(offset, offset + length)) });
        offset += length;
      } else {
        const length = (status & 0xf0) === 0xc0 ? 1 : 2;
        events.push({ track, tick, status, data: Array.from(bytes.subarray(offset, offset + length)) });
        offset += length;
      }
    }
    assert.equal(offset, end);
  }
  return events;
}
function wavInfo(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'RIFF');
  const dataBytes = view.getUint32(40, true);
  const rate = view.getUint32(24, true);
  assert.equal(bytes.length, 44 + dataBytes);
  return { samples: dataBytes / 4, duration: dataBytes / 4 / rate, pcm: bytes.subarray(44) };
}

test('inclusive source range clips sustained boundaries, rebases indexes and never mutates source', () => {
  const source = fixture();
  const snapshot = JSON.stringify(source);
  const excerpt = excerptScore(source, { start: 2, end: 3 });
  assert.equal(excerpt.totalBeats, 8);
  assert.equal(excerpt.playback, undefined);
  assert.equal(excerpt.xml, source.xml);
  assert.deepEqual(excerpt.measures, [
    { number: 1, startBeat: 0, duration: 4 },
    { number: 2, startBeat: 4, duration: 4 },
  ]);
  assert.deepEqual(
    excerpt.parts[0].notes.map((n) => [n.id, n.beat, n.duration, n.measure]),
    [
      ['left-crossing-tie', 0, 2, 1],
      ['inside', 0, 1, 1],
      ['right-crossing', 6, 2, 2],
    ],
  );
  assert.equal(excerpt.parts[0].notes[0].tie, 'merged');
  assert.deepEqual(
    excerpt.parts.map((p) => [p.id, p.instrument]),
    source.parts.map((p) => [p.id, p.instrument]),
  );
  assert.equal(excerpt.parts[2].notes.length, 0);
  assert.notEqual(excerpt.parts[0], source.parts[0]);
  assert.notEqual(excerpt.parts[0].notes[0], source.parts[0].notes[1]);
  assert.equal(JSON.stringify(source), snapshot);
});

test('single bar clipping derives note measures from source positions rather than printed numbers', () => {
  const excerpt = excerptScore(fixture(), { start: 3, end: 3 });
  assert.equal(excerpt.totalBeats, 4);
  assert.deepEqual(
    excerpt.parts[0].notes.map((n) => [n.beat, n.duration, n.measure]),
    [[2, 2, 1]],
  );
  assert.deepEqual(
    excerpt.parts[1].notes.map((n) => [n.beat, n.duration]),
    [[0, 4]],
  );
});

test('invalid, empty, fractional, nonfinite, reversed and out-of-bounds ranges fail explicitly', async () => {
  const score = fixture();
  for (const range of [
    undefined,
    null,
    {},
    { start: 0, end: 1 },
    { start: 1, end: 5 },
    { start: 3, end: 2 },
    { start: 1.5, end: 2 },
    { start: 1, end: 2.5 },
    { start: NaN, end: 2 },
    { start: 1, end: Infinity },
    { start: -2, end: -1 },
  ]) {
    assert.throws(() => excerptScore(score, range as { start: number; end: number }), /小节范围/);
  }
  assert.throws(() => excerptScore({ ...score, measures: [] }, { start: 1, end: 1 }), /小节范围/);
  assert.throws(
    () => excerptScore({ ...score, measures: [{ number: 1, startBeat: 0, duration: 0 }] }, { start: 1, end: 1 }),
    /时间线/,
  );
  assert.throws(() => exportMidi(score, { measureRange: { start: 2, end: 1 } }), /小节范围/);
  await assert.rejects(scoreToWav(score, { measureRange: { start: 2, end: 1 } }), /小节范围/);
});

test('actual MIDI note-on/off deltas reflect clipping, mute/transpose/tempo and exact excerpt end', () => {
  const source = fixture();
  const snapshot = JSON.stringify(source);
  const options = { measureRange: { start: 2, end: 3 }, mutedParts: ['left'], transpose: 2, tempo: 60 };
  const bytes = exportMidi(source, options);
  const events = midiEvents(bytes);
  const ons = events.filter((e) => (e.status & 0xf0) === 0x90);
  const offs = events.filter((e) => (e.status & 0xf0) === 0x80);
  assert.deepEqual(
    ons.map((e) => [e.tick, e.data[0]]),
    [
      [0, 62],
      [0, 64],
      [2880, 66],
    ],
  );
  assert.deepEqual(
    offs.map((e) => [e.tick, e.data[0]]),
    [
      [480, 64],
      [960, 62],
      [3840, 66],
    ],
  );
  assert.deepEqual(events.find((e) => e.meta === 0x51)?.data, [0x0f, 0x42, 0x40]);
  assert.deepEqual(
    events.filter((e) => e.meta === 0x2f).map((e) => e.tick),
    [3840, 3840, 3840, 3840],
  );
  assert.deepEqual(
    exportMidi(source, { ...options, followRepeats: true }),
    exportMidi(source, { ...options, followRepeats: false }),
  );
  assert.equal(JSON.stringify(source), snapshot);
});

test('rest-only and empty-part excerpts keep silent MIDI and WAV duration including trailing bars', async () => {
  for (const parts of [[{ id: 'empty', name: '', instrument: 0, notes: [] }], []]) {
    const score = { ...fixture(), parts };
    const options = { measureRange: { start: 2, end: 3 } };
    const events = midiEvents(exportMidi(score, options));
    assert.ok(events.every((e) => (e.status & 0xf0) !== 0x90));
    assert.ok(events.filter((e) => e.meta === 0x2f).every((e) => e.tick === 3840));
    const wav = wavInfo(await scoreToWav(score, options));
    assert.equal(wav.samples, 198450);
    assert.equal(wav.duration, 4.5);
    assert.ok(wav.pcm.every((byte) => byte === 0));
  }
});

test('WAV test-PCM bytes match an independent clipped performance with settings and ignore repeat expansion', async () => {
  const source = fixture();
  const expected: Score = {
    ...source,
    totalBeats: 8,
    playback: undefined,
    parts: [
      {
        id: 'right',
        name: 'Right',
        instrument: 4,
        notes: [makeNote('a', 0, 2, 60), makeNote('b', 0, 1, 62), makeNote('c', 6, 2, 64)],
      },
    ],
  };
  const options = { tempo: 60, transpose: 3, mutedParts: ['left'], measureRange: { start: 2, end: 3 } };
  const bytes = await scoreToWav(source, options);
  assert.deepEqual(bytes, await scoreToWav(expected, { tempo: 60, transpose: 3 }));
  assert.equal(wavInfo(bytes).duration, 8.5);
  assert.deepEqual(bytes, await scoreToWav(source, { ...options, followRepeats: false }));
  const silent = wavInfo(await scoreToWav(source, { ...options, mutedParts: ['right', 'left'] }));
  assert.ok(silent.pcm.every((byte) => byte === 0));
});

test('whole-score repeat defaults remain and original First Light measures3..4 have acceptance durations', async () => {
  const repeat = fixture();
  const countOns = (bytes: Uint8Array) => midiEvents(bytes).filter((e) => (e.status & 0xf0) === 0x90).length;
  assert.equal(countOns(exportMidi(repeat)), 12);
  assert.equal(countOns(exportMidi(repeat, { followRepeats: false })), 6);
  const score = await readScore(await readFile('public/samples/first-light.musicxml', 'utf8'));
  const clip = await scoreToWav(score, { tempo: 120, measureRange: { start: 3, end: 4 } });
  assert.equal(wavInfo(clip).duration, 4.5);
  assert.equal(wavInfo(await scoreToWav(score, { tempo: 120 })).duration, 16.5);
  assert.deepEqual(
    midiEvents(exportMidi(score, { measureRange: { start: 3, end: 4 } }))
      .filter((e) => e.meta === 0x2f)
      .map((e) => e.tick),
    [3840, 3840, 3840],
  );
});
