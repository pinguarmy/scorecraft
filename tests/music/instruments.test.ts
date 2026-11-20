import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_INSTRUMENT,
  INSTRUMENTS,
  loadInstrumentBank,
  scheduleInstrumentNote,
  getInstrumentWarnings,
} from '../../src/music/instruments';
import { exportMidi, scoreToWav } from '../../src/music/export';
import { readScore } from '../../src/music/index';
import type { Score } from '../../src/music/types';
import { installTestOfflinePcm, TestOfflineContext } from './helpers/offline-pcm';
const restore = installTestOfflinePcm();
after(restore);
const ctx = () => new TestOfflineContext(2, 44100, 44100);
const asAudio = (context: TestOfflineContext) => context as unknown as BaseAudioContext;
function fixture(): Score {
  return {
    title: 'Color study',
    composer: 'ScoreCraft',
    tempo: 120,
    beatsPerMeasure: 4,
    totalBeats: 4,
    measures: [{ number: 1, startBeat: 0, duration: 4 }],
    xml: '',
    warnings: [],
    parts: [
      {
        id: 'melody',
        name: 'Melody',
        instrument: 0,
        notes: [{ id: 'a', partId: 'melody', midi: 60, velocity: 80, beat: 0, duration: 1, measure: 1 }],
      },
      {
        id: 'bass',
        name: 'Bass',
        instrument: 0,
        notes: [{ id: 'b', partId: 'bass', midi: 40, velocity: 80, beat: 0, duration: 2, measure: 1 }],
      },
      {
        id: 'drum',
        name: 'Drum',
        instrument: 0,
        notes: [
          { id: 'c', partId: 'drum', midi: 36, percussion: 36, velocity: 90, beat: 1, duration: 0.25, measure: 1 },
        ],
      },
    ],
  };
}
function midiMessages(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer);
  let offset = 14;
  const events: { status: number; data: number[] }[] = [];
  const variable = () => {
    let n = 0,
      b;
    do {
      b = bytes[offset++];
      n = n * 128 + (b & 127);
    } while (b & 128);
    return n;
  };
  while (offset < bytes.length) {
    const end = offset + 8 + view.getUint32(offset + 4);
    offset += 8;
    while (offset < end) {
      variable();
      const status = bytes[offset++];
      if (status === 255) {
        offset++;
        const length = variable();
        offset += length;
      } else {
        const length = (status & 240) === 192 ? 1 : 2;
        events.push({ status, data: Array.from(bytes.slice(offset, offset + length)) });
        offset += length;
      }
    }
  }
  return events;
}

test('registry matches exact IDs and local sample manifests with no pretend ensemble or synth fallback', async () => {
  assert.equal(DEFAULT_INSTRUMENT, 'piano-bright');
  assert.equal(INSTRUMENTS.length, 8);
  assert.equal(INSTRUMENTS.find((item) => item.id === 'strings')?.label, '弦乐·小提琴');
  const manifest = JSON.parse(await readFile('public/audio/instruments/source-manifest.json', 'utf8'));
  const context = ctx();
  for (const id of ['guitar-acoustic', 'guitar-electric', 'bass-electric', 'strings'] as const) {
    const bank = await loadInstrumentBank(asAudio(context), id);
    const expected = manifest.samples
      .filter((sample: { instrument: string }) => sample.instrument === id)
      .map((sample: { midi: number }) => sample.midi)
      .sort((a: number, b: number) => a - b);
    assert.deepEqual(
      bank.samples?.map((sample) => sample.midi),
      expected,
    );
  }
});

test('bright uses same piano recordings plus EQ, warm untreated, and sample voice cancels completely', async () => {
  const context = ctx();
  const audio = asAudio(context);
  const warm = await loadInstrumentBank(audio, 'piano-warm');
  const bright = await loadInstrumentBank(audio, 'piano-bright');
  assert.equal(warm.samples, bright.samples);
  const voice = scheduleInstrumentNote(
    audio,
    context.destination as unknown as AudioNode,
    bright,
    { midi: 60, velocity: 80 },
    0,
    1,
  )!;
  assert.equal(context.filters[0].type, 'highshelf');
  assert.equal(context.filters[0].gain.value, 3);
  assert.equal(context.filters[0].frequency.value, 2000);
  const filters = context.filters.length;
  scheduleInstrumentNote(audio, context.destination as unknown as AudioNode, warm, { midi: 60, velocity: 80 }, 0, 1);
  assert.equal(context.filters.length, filters);
  voice.stop(0.1);
  assert.equal(context.sources[0].until, 0.1);
  let ended = 0;
  voice.onended = () => ended++;
  context.sources[0].onended?.();
  context.sources[0].onended?.();
  assert.equal(ended, 1);
  voice.disconnect();
  assert.equal(context.sources[0].destination, undefined);
});

test('explicit synth composite and electronic GM drums terminate children and skip unsupported notes', async () => {
  const context = ctx(),
    audio = asAudio(context);
  const synth = await loadInstrumentBank(audio, 'synth-pad');
  const voice = scheduleInstrumentNote(
    audio,
    context.destination as unknown as AudioNode,
    synth,
    { midi: 60, velocity: 80 },
    0,
    1,
  )!;
  assert.equal(context.oscillators.length, 2);
  let ended = 0;
  voice.onended = () => ended++;
  voice.stop(0.2);
  assert.ok(context.oscillators.every((node) => node.until === 0.2));
  context.oscillators[0].onended?.(new Event('ended'));
  assert.equal(ended, 0);
  context.oscillators[1].onended?.(new Event('ended'));
  assert.equal(ended, 1);
  const drums = await loadInstrumentBank(audio, 'drums');
  assert.ok(
    scheduleInstrumentNote(
      audio,
      context.destination as unknown as AudioNode,
      drums,
      { midi: 60, percussion: 36, velocity: 80 },
      0,
      0.1,
    ),
  );
  assert.equal(
    scheduleInstrumentNote(audio, context.destination as unknown as AudioNode, drums, { midi: 60, velocity: 80 }, 0, 1),
    null,
  );
  assert.match(getInstrumentWarnings(fixture(), { melody: 'drums' })[0], /不会自动/);
});

test('sample load failures do not cross instruments, are retryable and unknown IDs reject', async () => {
  const oldFetch = globalThis.fetch;
  const context = new TestOfflineContext(2, 48000, 48000);
  try {
    globalThis.fetch = async () => {
      throw new Error('test unavailable');
    };
    await assert.rejects(loadInstrumentBank(asAudio(context), 'guitar-acoustic'), /采样加载失败/);
  } finally {
    globalThis.fetch = oldFetch;
  }
  assert.equal((await loadInstrumentBank(asAudio(context), 'guitar-acoustic')).samples?.length, 13);
  await assert.rejects(loadInstrumentBank(asAudio(context), 'unknown' as 'strings'), /未知/);
});

test('MIDI selected programs and drum channel preserve simultaneous pitched and percussion notes', () => {
  const messages = midiMessages(
    exportMidi(fixture(), {
      transpose: 2,
      partInstruments: { melody: 'guitar-acoustic', bass: 'bass-electric', drum: 'drums' },
    }),
  );
  assert.deepEqual(
    messages.filter((event) => (event.status & 240) === 192).map((event) => [event.status & 15, event.data[0]]),
    [
      [0, 24],
      [1, 33],
      [9, 0],
    ],
  );
  assert.deepEqual(
    messages.filter((event) => (event.status & 240) === 144).map((event) => [event.status & 15, event.data[0]]),
    [
      [0, 62],
      [1, 42],
      [9, 36],
    ],
  );
  const many = fixture();
  many.parts = Array.from({ length: 12 }, (_, i) => ({
    ...many.parts[0],
    id: `p${i}`,
    notes: [{ ...many.parts[0].notes[0], partId: `p${i}` }],
  }));
  assert.ok(
    midiMessages(exportMidi(many))
      .filter((event) => (event.status & 240) === 144)
      .every((event) => (event.status & 15) !== 9),
  );
});

test('offline uses selected sampled banks at same times with no instrument oscillators', async () => {
  const score = fixture();
  score.parts = score.parts.slice(0, 2);
  const wav = await scoreToWav(score, { partInstruments: { melody: 'guitar-electric', bass: 'bass-electric' } });
  const context = TestOfflineContext.contexts.at(-1)!;
  assert.equal(context.sources.length, 2);
  assert.equal(context.oscillators.length, 0);
  assert.equal(context.sources[0].at, context.sources[1].at);
  assert.equal(new DataView(wav.buffer).getUint16(22, true), 2);
  assert.ok(wav.subarray(44).some((value) => value !== 0));
});

test('structured unpitched parsing uses per-instrument midi-unpitched rather than display pitch', async () => {
  const xml = `<score-partwise><part-list><score-part id="P1"><part-name>Drums</part-name><midi-instrument id="kick"><midi-unpitched>37</midi-unpitched></midi-instrument><midi-instrument id="snare"><midi-unpitched>39</midi-unpitched></midi-instrument></score-part></part-list><part id="P1"><measure><attributes><divisions>1</divisions></attributes><note><instrument id="kick"/><unpitched><display-step>C</display-step><display-octave>5</display-octave></unpitched><duration>1</duration></note><note><instrument id="snare"/><unpitched><display-step>C</display-step><display-octave>5</display-octave></unpitched><duration>1</duration></note><note><unpitched/><duration>1</duration></note></measure></part></score-partwise>`;
  const parsed = await readScore(xml);
  assert.deepEqual(
    parsed.parts[0].notes.map((note) => note.percussion),
    [36, 38],
  );
  assert.ok(parsed.warnings.some((warning) => warning.includes('未猜测鼓件')));
});
