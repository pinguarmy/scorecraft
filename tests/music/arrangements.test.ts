import test from 'node:test';
import assert from 'node:assert/strict';
import { ARRANGEMENTS, allPartsInstrumentMap, getArrangementMap, type ArrangementPreset } from '../../src/music/arrangements';
import type { InstrumentId } from '../../src/music/instruments';
import type { Score, ScoreNote, ScorePart } from '../../src/music/types';

function part(id: string, pitches: number[], extra: Partial<ScoreNote> = {}): ScorePart {
  return { id, name: 'Voice', instrument: 0, notes: pitches.map((midi, index) => ({ id: `${id}-${index}`, partId: id, measure: 1, beat: index, duration: 1, midi, velocity: 80, ...extra })) };
}
const score: Score = {
  title: 'Original exercise', composer: 'Test', tempo: 100, beatsPerMeasure: 4,
  parts: [part('low', [48, 50, 52]), part('high', [60, 64, 67]), part('drums', [60, 60], { percussion: 38 })],
  measures: [{ number: 1, startBeat: 0, duration: 4 }], totalBeats: 4, warnings: [], xml: '<source-preserved/>',
};

test('all five explicit presets cover every part and preserve actual percussion', () => {
  assert.deepEqual(ARRANGEMENTS.map(item => item.id), ['piano-bright', 'piano-warm', 'acoustic', 'strings', 'electronic']);
  for (const preset of ['piano-bright', 'piano-warm'] as const) {
    assert.deepEqual(getArrangementMap(score, preset), { low: preset, high: preset, drums: 'drums' });
  }
  assert.deepEqual(getArrangementMap(score, 'acoustic'), { low: 'bass-electric', high: 'guitar-acoustic', drums: 'drums' });
  assert.deepEqual(getArrangementMap(score, 'strings'), { low: 'strings', high: 'strings', drums: 'drums' });
  assert.deepEqual(getArrangementMap(score, 'electronic'), { low: 'bass-electric', high: 'synth-pad', drums: 'drums' });
});

test('range presets use a sorted MIDI median, not labels or first note', () => {
  const low = part('L', [100, 30, 40]); low.name = 'Violin'; low.instrument = 40;
  const high = part('H', [20, 100, 90]); high.name = 'Bass Electric'; high.instrument = 33;
  assert.deepEqual(getArrangementMap({ parts: [low, high] }, 'acoustic'), { L: 'bass-electric', H: 'guitar-acoustic' });
  assert.deepEqual(getArrangementMap({ parts: [part('below', [54, 55]), part('edge', [54, 56]), part('odd', [80, 55, 20])] }, 'electronic'), {
    below: 'bass-electric', edge: 'synth-pad', odd: 'synth-pad',
  });
});

test('empty notes, invalid pitches, mixed percussion and drum-like labels do not manufacture drums or low parts', () => {
  const silent = part('silent', []);
  const invalid = part('invalid', [Number.NaN, Number.POSITIVE_INFINITY, -20, 200]);
  const labelled = part('labelled', [64]); labelled.name = 'Drums';
  const mixed = part('mixed', [40]); mixed.notes.push(...part('mixed', [80], { percussion: 38 }).notes);
  const invalidPercussion = part('invalid-percussion', [40], { percussion: 128 });
  const mapping = getArrangementMap({ parts: [silent, invalid, labelled, mixed, invalidPercussion] }, 'acoustic');
  assert.deepEqual(mapping, { silent: 'guitar-acoustic', invalid: 'guitar-acoustic', labelled: 'guitar-acoustic', mixed: 'bass-electric', 'invalid-percussion': 'guitar-acoustic' });
});

test('uniform user choice overrides preset percussion retention, except invalid all-drums melody', () => {
  assert.deepEqual(allPartsInstrumentMap(score, 'guitar-electric'), { low: 'guitar-electric', high: 'guitar-electric', drums: 'guitar-electric' });
  assert.throws(() => allPartsInstrumentMap(score, 'drums'), /不能将旋律声部/);
  assert.deepEqual(allPartsInstrumentMap({ parts: [score.parts[2]] }, 'drums'), { drums: 'drums' });
  assert.throws(() => allPartsInstrumentMap({ parts: [part('empty', [])] }, 'drums'), /不能将旋律声部/);
});

test('maps are deterministic fresh values and leave all source content unchanged', () => {
  const before = structuredClone(score);
  const a = getArrangementMap(score, 'acoustic'); const b = getArrangementMap(score, 'acoustic');
  assert.deepEqual(a, b); assert.notEqual(a, b);
  a.low = 'strings';
  assert.equal(b.low, 'bass-electric');
  allPartsInstrumentMap(score, 'piano-warm');
  assert.deepEqual(score, before);
  const unusual = part('__proto__', [60]);
  const map = getArrangementMap({ parts: [unusual] }, 'strings');
  assert.equal(Object.hasOwn(map, '__proto__'), true); assert.equal(map.__proto__, 'strings');
});

test('empty scores, unknown options and ambiguous IDs fail explicitly', () => {
  assert.throws(() => getArrangementMap({ parts: [] }, 'strings'), /没有声部/);
  assert.throws(() => allPartsInstrumentMap({ parts: [] }, 'strings'), /没有声部/);
  assert.throws(() => getArrangementMap(score, 'guess' as ArrangementPreset), /未知音色组合/);
  assert.throws(() => allPartsInstrumentMap(score, 'guess' as InstrumentId), /未知音色/);
  assert.throws(() => getArrangementMap({ parts: [part('same', [60]), part('same', [50])] }, 'strings'), /编号为空或重复/);
  assert.throws(() => allPartsInstrumentMap({ parts: [part(' ', [60])] }, 'strings'), /编号为空或重复/);
});
