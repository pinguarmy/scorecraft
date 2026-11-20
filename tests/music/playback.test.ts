import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readScore, getPlaybackScore, exportMidi, scoreToWav } from '../../src/music/index';
import { playbackToSource, sourceToPlayback } from '../../src/music/playback';
import type { Score } from '../../src/music/types';
import { after } from 'node:test';
import { installTestOfflinePcm } from './helpers/offline-pcm';
const restoreOfflinePcm = installTestOfflinePcm();
after(restoreOfflinePcm);

function midiOns(midi: Uint8Array) {
  const view = new DataView(midi.buffer, midi.byteOffset, midi.byteLength);
  const notes: { tick: number; pitch: number }[] = [];
  let offset = 14;
  const variable = () => {
    let n = 0;
    let b;
    do {
      b = midi[offset++];
      n = n * 128 + (b & 127);
    } while (b & 128);
    return n;
  };
  while (offset < midi.length) {
    const end = offset + 8 + view.getUint32(offset + 4);
    offset += 8;
    let tick = 0;
    while (offset < end) {
      tick += variable();
      const status = midi[offset++];
      if (status === 0xff) {
        offset++;
        const length = variable();
        offset += length;
      } else {
        const length = (status & 0xf0) === 0xc0 ? 1 : 2;
        if ((status & 0xf0) === 0x90 && midi[offset + 1]) notes.push({ tick, pitch: midi[offset] });
        offset += length;
      }
    }
  }
  return notes;
}

test('repeat study keeps source stable, materializes performance and exports the written sequence', async () => {
  const score = await readScore(await readFile('public/samples/repeat-study.musicxml', 'utf8'));
  const snapshot = JSON.stringify(score);
  assert.equal(score.totalBeats, 16);
  assert.equal(score.measures.length, 4);
  assert.equal(score.parts[0].notes.length, 4);
  assert.equal(score.playback?.expanded, true);
  assert.equal(score.playback?.totalBeats, 24);
  const performance = getPlaybackScore(score);
  const expected = [60, 62, 64, 62, 64, 60];
  assert.deepEqual(
    performance.parts[0].notes.map((n) => n.midi),
    expected,
  );
  assert.equal(performance.measures.length, 6);
  assert.equal(performance.totalBeats, 24);
  assert.equal(new Set(performance.parts[0].notes.map((n) => n.id)).size, 6);
  assert.equal(getPlaybackScore(performance), performance, 'materialization is idempotent');
  assert.equal(playbackToSource(score, 12), 4);
  assert.equal(playbackToSource(score, 17.5), 9.5);
  assert.equal(sourceToPlayback(score, 4), 4);
  assert.equal(playbackToSource(score, 24), 16);
  assert.deepEqual(
    midiOns(exportMidi(score)).map((n) => n.pitch),
    expected,
  );
  assert.deepEqual(
    midiOns(exportMidi(score)).map((n) => n.tick),
    expected.map((_, i) => i * 4 * 480),
  );
  assert.deepEqual(
    midiOns(exportMidi(score, { followRepeats: false })).map((n) => n.pitch),
    [60, 62, 64, 60],
  );
  const manualPerformance: Score = {
    ...score,
    playback: undefined,
    totalBeats: 24,
    parts: [
      {
        ...score.parts[0],
        notes: expected.map((midi, i) => ({
          id: `manual${i}`,
          partId: score.parts[0].id,
          measure: i + 1,
          beat: i * 4,
          duration: 4,
          midi,
          velocity: 84,
        })),
      },
    ],
  };
  assert.deepEqual(
    await scoreToWav(score),
    await scoreToWav(manualPerformance),
    'WAV test PCM matches an independently written expected note sequence',
  );
  assert.ok((await scoreToWav(score)).length > (await scoreToWav(score, { followRepeats: false })).length);
  assert.equal(JSON.stringify(score), snapshot, 'all operations leave the source timeline/XML unchanged');
  assert.match(score.xml, /direction="backward"/);
  assert.equal(score.warnings.length, 0);
});

test('notes crossing a repeat jump clip there, while contiguous measure sustains stay intact', () => {
  const score: Score = {
    title: '',
    composer: '',
    tempo: 120,
    beatsPerMeasure: 4,
    totalBeats: 12,
    xml: '',
    warnings: [],
    measures: [0, 4, 8].map((startBeat, i) => ({ number: i + 1, startBeat, duration: 4 })),
    parts: [
      {
        id: 'p',
        name: '',
        instrument: 0,
        notes: [{ id: 'held', partId: 'p', measure: 1, beat: 2, duration: 8, midi: 60, velocity: 80 }],
      },
    ],
    playback: {
      segments: [
        { sourceStart: 0, sourceEnd: 4, playStart: 0 },
        { sourceStart: 4, sourceEnd: 8, playStart: 4 },
        { sourceStart: 0, sourceEnd: 4, playStart: 8 },
        { sourceStart: 4, sourceEnd: 8, playStart: 12 },
        { sourceStart: 8, sourceEnd: 12, playStart: 16 },
      ],
      totalBeats: 20,
      expanded: true,
    },
  };
  const performance = getPlaybackScore(score);
  assert.deepEqual(
    performance.parts[0].notes.map((n) => [n.beat, n.duration]),
    [
      [2, 6],
      [10, 8],
    ],
  );
  assert.equal(score.parts[0].notes[0].duration, 8);
});
