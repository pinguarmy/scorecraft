import test from 'node:test';
import assert from 'node:assert/strict';
import { ScorePlayer } from '../../src/music/player';
import type { Score } from '../../src/music/types';

class Param {
  value = 0;
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  exponentialRampToValueAtTime() {}
}
class FakeGain {
  gain = new Param();
  connect() {}
  disconnect() {}
}
class FakeOscillator {
  frequency = new Param();
  type = '';
  onended?: () => void;
  stopped = false;
  connect() {}
  disconnect() {}
  start() {}
  stop() {
    this.stopped = true;
  }
}
class FakeSource {
  buffer?: AudioBuffer;
  playbackRate = new Param();
  loop = false;
  onended?: () => void;
  offset = 0;
  stopped = false;
  starts: number[] = [];
  stops: Array<number | undefined> = [];
  connect() {}
  disconnect() {}
  start(at: number, offset: number) {
    this.starts.push(at);
    this.offset = offset;
  }
  stop(at?: number) {
    this.stops.push(at);
    this.stopped = true;
  }
}
class FakeContext {
  static instance: FakeContext;
  static rate = 44100;
  sampleRate = FakeContext.rate;
  currentTime = 0;
  destination = {};
  oscillators: FakeOscillator[] = [];
  sources: FakeSource[] = [];
  closed = false;
  async decodeAudioData() {
    return { length: 441000, duration: 10, numberOfChannels: 2 } as AudioBuffer;
  }
  createBufferSource() {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  constructor() {
    FakeContext.instance = this;
  }
  async resume() {}
  async close() {
    this.closed = true;
  }
  createGain() {
    return new FakeGain();
  }
  filters: Array<{ type: string; frequency: Param; gain: Param; connect(): void; disconnect(): void }> = [];
  createBiquadFilter() {
    const filter = { type: '', frequency: new Param(), gain: new Param(), connect() {}, disconnect() {} };
    this.filters.push(filter);
    return filter;
  }
  createOscillator() {
    const osc = new FakeOscillator();
    this.oscillators.push(osc);
    return osc;
  }
  createBuffer(channels: number, length: number, sampleRate: number) {
    return {
      length,
      duration: length / sampleRate,
      numberOfChannels: channels,
      getChannelData: () => new Float32Array(length),
    } as unknown as AudioBuffer;
  }
}
const nativeFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]));
test.after(() => {
  globalThis.fetch = nativeFetch;
});
const score: Score = {
  title: 'test',
  composer: '',
  tempo: 120,
  beatsPerMeasure: 4,
  totalBeats: 8,
  warnings: [],
  xml: '',
  measures: [
    { number: 1, startBeat: 0, duration: 4 },
    { number: 2, startBeat: 4, duration: 4 },
  ],
  parts: [
    {
      id: 'right',
      name: '右手',
      instrument: 0,
      notes: [{ id: 'a', partId: 'right', measure: 1, beat: 0, duration: 4, midi: 69, velocity: 80 }],
    },
    {
      id: 'left',
      name: '左手',
      instrument: 0,
      notes: [{ id: 'b', partId: 'left', measure: 1, beat: 0, duration: 4, midi: 57, velocity: 80 }],
    },
  ],
};

test('player supports mute, transpose, seek sustain, pause and disposal using Web Audio API', async () => {
  const old = globalThis.AudioContext;
  globalThis.AudioContext = FakeContext as unknown as typeof AudioContext;
  const states: boolean[] = [];
  const positions: number[] = [];
  const player = new ScorePlayer({ onPosition: (b) => positions.push(b), onState: (p) => states.push(p) });
  try {
    player.load(score);
    player.setMutedParts(['left']);
    player.setTranspose(12);
    await player.play();
    const context = FakeContext.instance;
    assert.equal(context.sources.length, 1);
    assert.equal(context.sources[0].playbackRate.value, 1, 'transposed MIDI81 selects recorded A5 root');
    assert.equal(context.oscillators.length, 0, 'instruments must not use oscillators');
    context.currentTime = 0.5;
    player.pause();
    player.seek(2);
    await player.play();
    assert.ok(context.sources.length >= 2, 'seek into held note must resume its remaining sustain');
    assert.ok(
      context.sources.at(-1)!.offset > 0,
      'seek sustain uses interior recorded decay rather than a new hammer attack',
    );
    player.setTempo(60);
    player.setLoop(4, 8, true);
    player.setMetronome(true);
    player.stop();
    assert.equal(positions.at(-1), 0);
    assert.ok(states.includes(true));
    assert.equal(states.at(-1), false);
  } finally {
    player.dispose();
    globalThis.AudioContext = old;
  }
  assert.equal(FakeContext.instance.closed, true);
});

test('written repeats report source beats and preserve second passage across pause and live settings', async () => {
  const old = globalThis.AudioContext;
  globalThis.AudioContext = FakeContext as unknown as typeof AudioContext;
  const positions: number[] = [];
  const player = new ScorePlayer({ onPosition: (beat) => positions.push(beat) });
  const tick = () => (player as unknown as { tick(): void }).tick();
  const repeated: Score = {
    ...score,
    playback: {
      segments: [
        { sourceStart: 0, sourceEnd: 8, playStart: 0 },
        { sourceStart: 0, sourceEnd: 8, playStart: 8 },
      ],
      totalBeats: 16,
      expanded: true,
    },
  };
  try {
    player.load(repeated);
    await player.play();
    const context = FakeContext.instance;
    context.currentTime = 4.5;
    tick();
    assert.equal(positions.at(-1), 1, 'second pass rewinds callback to source beat');
    player.pause();
    assert.equal(positions.at(-1), 1);
    await player.play();
    player.setTempo(60);
    player.setTranspose(1);
    player.setMutedParts(['left']);
    player.setMetronome(true);
    player.setFollowRepeats(true);
    player.setLoop(0, 8, false);
    player.setLoop(1, 7, false);
    context.currentTime = 5.5;
    tick();
    assert.equal(positions.at(-1), 2, 'live controls retain second pass');
    player.setLoop(0, 8, true);
    context.currentTime = 6.5;
    tick();
    assert.equal(positions.at(-1), 3);
    player.setLoop(0, 8, false);
    context.currentTime = 12;
    tick();
    assert.equal(
      positions.at(-1),
      0.5,
      'disabling loop maps source position to first occurrence, then reaches repeat again',
    );
    player.seek(2);
    context.currentTime = 13;
    tick();
    assert.equal(positions.at(-1), 3, 'seek uses first occurrence');
    player.setFollowRepeats(false);
    context.currentTime = 14;
    tick();
    assert.equal(positions.at(-1), 4);
    context.currentTime = 30;
    tick();
    assert.equal(positions.at(-1), 8, 'completion reports source total');
    player.setFollowRepeats(true);
    player.seek(0);
    await player.play();
    context.currentTime = 50;
    tick();
    assert.equal(positions.at(-1), 8);
  } finally {
    player.dispose();
    globalThis.AudioContext = old;
  }
});

test('distinct per-part samples load only unmuted banks and instrument changes pause without losing position', async () => {
  const old = globalThis.AudioContext;
  const fetchBefore = globalThis.fetch;
  globalThis.AudioContext = FakeContext as unknown as typeof AudioContext;
  FakeContext.rate = 47001;
  const urls: string[] = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return new Response(new Uint8Array([1]));
  };
  const positions: number[] = [];
  const states: boolean[] = [];
  const player = new ScorePlayer({ onPosition: (b) => positions.push(b), onState: (state) => states.push(state) });
  try {
    player.load(score);
    player.setPartInstruments({ right: 'guitar-acoustic', left: 'piano-warm' });
    player.setMutedParts(['left']);
    await player.play();
    assert(urls.every((url) => url.startsWith('/audio/instruments/guitar-acoustic/')));
    assert.equal(FakeContext.instance.sources.length, 1);
    FakeContext.instance.currentTime = 0.5;
    player.setMutedParts([]);
    assert.equal(states.at(-1), false, 'unmute unready bank pauses for explicit Play');
    assert.equal(positions.at(-1), 1);
    await player.play();
    assert(urls.some((url) => url.startsWith('/audio/piano/')));
    assert.equal(FakeContext.instance.sources.length, 3, 'both distinct sampled parts schedule together');
    player.setPartInstruments({ left: 'piano-warm', right: 'guitar-acoustic' });
    assert.equal(states.at(-1), true, 'same map with different property order is no-op');
    FakeContext.instance.currentTime = 0.75;
    player.setPartInstruments({ right: 'piano-warm', left: 'piano-warm' });
    assert.equal(states.at(-1), false);
    assert.equal(positions.at(-1), 1.5);
    player.load(score);
    await player.play();
    assert(
      FakeContext.instance.filters.some((filter) => filter.type === 'highshelf'),
      'load clears stale map to default bright piano',
    );
  } finally {
    player.dispose();
    globalThis.AudioContext = old;
    globalThis.fetch = fetchBefore;
    FakeContext.rate = 44100;
  }
});

test('instrument map changes cancel pending loading, normalize default no-ops and cannot late-start', async () => {
  const old = globalThis.AudioContext;
  const fetchBefore = globalThis.fetch;
  globalThis.AudioContext = FakeContext as unknown as typeof AudioContext;
  FakeContext.rate = 47002;
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  globalThis.fetch = async () => {
    await wait;
    return new Response(new Uint8Array([1]));
  };
  const audio: string[] = [];
  const player = new ScorePlayer({ onAudioState: (state) => audio.push(state) });
  try {
    player.load(score);
    const pending = player.play();
    await new Promise<void>((resolve) => setImmediate(resolve));
    player.setPartInstruments({ right: 'piano-bright', unknown: 'strings' });
    assert.deepEqual(audio, ['loading'], 'default entries and unknown part normalize away');
    player.setPartInstruments({ right: 'guitar-electric' });
    assert.deepEqual(audio, ['loading', 'idle']);
    release();
    await pending;
    assert.equal(FakeContext.instance.sources.length, 0);
    assert.equal(FakeContext.instance.oscillators.length, 0);
  } finally {
    release();
    player.dispose();
    globalThis.AudioContext = old;
    globalThis.fetch = fetchBefore;
    FakeContext.rate = 44100;
  }
});

test('drums only play explicit percussion and remain untransposed, synth is explicit and cancellable', async () => {
  const old = globalThis.AudioContext;
  globalThis.AudioContext = FakeContext as unknown as typeof AudioContext;
  FakeContext.rate = 47003;
  const player = new ScorePlayer();
  try {
    const percussion: Score = {
      ...score,
      parts: [
        {
          ...score.parts[0],
          notes: [
            { ...score.parts[0].notes[0], midi: 36 },
            { ...score.parts[0].notes[0], id: 'kick', midi: 60, percussion: 36 },
          ],
        },
      ],
    };
    player.load(percussion);
    player.setPartInstruments({ right: 'drums' });
    player.setTranspose(12);
    await player.play();
    assert.equal(FakeContext.instance.oscillators.length, 1, 'melodic MIDI36 without percussion metadata is skipped');
    player.stop();
    assert(FakeContext.instance.oscillators[0].stopped);
    player.load(score);
    player.setMutedParts(['left']);
    player.setPartInstruments({ right: 'synth-pad' });
    await player.play();
    const synth = FakeContext.instance.oscillators.slice(1);
    assert.equal(synth.length, 2);
    assert(synth.some((osc) => osc.type === 'triangle'));
    player.stop();
    assert(
      synth.every((osc) => osc.stopped),
      'composite synth sources all stop',
    );
  } finally {
    player.dispose();
    globalThis.AudioContext = old;
    FakeContext.rate = 44100;
  }
});

test('music horizon covers 400ms scheduler gap without moving source ahead and stop cancels future notes', async () => {
  const old = globalThis.AudioContext;
  globalThis.AudioContext = FakeContext as unknown as typeof AudioContext;
  const positions: number[] = [];
  const player = new ScorePlayer({ onPosition: (beat) => positions.push(beat) });
  const quick: Score = {
    ...score,
    parts: [
      {
        ...score.parts[0],
        notes: Array.from({ length: 12 }, (_, index) => ({
          ...score.parts[0].notes[0],
          id: `quick${index}`,
          beat: index * 0.25,
          duration: 0.25,
        })),
      },
    ],
  };
  try {
    player.load(quick);
    await player.play();
    const context = FakeContext.instance;
    assert.deepEqual(
      context.sources.map((source) => source.starts[0]),
      [0, 0.125, 0.25, 0.375, 0.5, 0.625],
    );
    assert.equal(positions.at(-1), 0, 'scheduling future audio never advances reported source beat');
    context.currentTime = 0.4; // No scheduler tick during these 400ms.
    assert(
      context.sources.some((source) => source.starts[0] === 0.375),
      'notes during blocked interval were already scheduled',
    );
    (player as unknown as { tick(): void }).tick();
    assert.equal(positions.at(-1), 0.8);
    assert(context.sources.length <= 9, 'finite .65s lookahead does not queue the entire score');
    const future = context.sources.filter((source) => source.starts[0] > context.currentTime);
    assert(future.length > 0);
    player.stop();
    assert(
      future.every((source) => source.stops.includes(undefined)),
      'future scheduled notes are cancelled',
    );
  } finally {
    player.dispose();
    globalThis.AudioContext = old;
  }
});

test('longer music horizon never schedules beyond loop end and seek cancels prior future notes', async () => {
  const old = globalThis.AudioContext;
  globalThis.AudioContext = FakeContext as unknown as typeof AudioContext;
  const positions: number[] = [];
  const player = new ScorePlayer({ onPosition: (beat) => positions.push(beat) });
  const quick: Score = {
    ...score,
    parts: [
      {
        ...score.parts[0],
        notes: Array.from({ length: 12 }, (_, index) => ({
          ...score.parts[0].notes[0],
          id: `loop${index}`,
          beat: index * 0.25,
          duration: 1,
        })),
      },
    ],
  };
  try {
    player.load(quick);
    player.setLoop(0, 1, true);
    await player.play();
    const context = FakeContext.instance;
    assert.equal(context.sources.length, 4);
    assert(context.sources.every((source) => source.starts[0] < 0.5));
    assert(
      context.sources.every((source) => source.stops[0] === 0.85),
      'musical durations clip at loop end, with existing .35 release',
    );
    const prior = [...context.sources];
    player.seek(0.5);
    assert(prior.every((source) => source.stops.includes(undefined)));
    assert.equal(positions.at(-1), 0.5);
    assert(context.sources.slice(prior.length).every((source) => source.starts[0] < 0.25));
  } finally {
    player.dispose();
    globalThis.AudioContext = old;
  }
});

test('pause cancels pending async play and no score means no audio work', async () => {
  const old = globalThis.AudioContext;
  globalThis.AudioContext = FakeContext as unknown as typeof AudioContext;
  const player = new ScorePlayer();
  try {
    await player.play();
    player.load(score);
    const pending = player.play();
    player.pause();
    await pending;
    assert.equal(FakeContext.instance.oscillators.length, 0);
  } finally {
    player.dispose();
    globalThis.AudioContext = old;
  }
});

test('loop wrap preserves overshoot at 120BPM: tick at .55s for 0..1 beat loop lands at .1 beat', async () => {
  const old = globalThis.AudioContext;
  globalThis.AudioContext = FakeContext as unknown as typeof AudioContext;
  const positions: number[] = [];
  const player = new ScorePlayer({ onPosition: (b) => positions.push(b) });
  const tick = () => (player as unknown as { tick(): void }).tick();
  const loopScore: Score = {
    ...score,
    tempo: 120,
    totalBeats: 4,
    measures: [{ number: 1, startBeat: 0, duration: 4 }],
    parts: [{ ...score.parts[0], notes: [{ ...score.parts[0].notes[0], beat: 0, duration: 0.5 }] }],
  };
  try {
    player.load(loopScore);
    player.setLoop(0, 1, true);
    await player.play();
    const context = FakeContext.instance;
    // 120 BPM -> 0.5s per beat. Loop 0..1 beat = 0.5s duration.
    // At t=0.55s, boundary is at 0.5s, overshoot = 0.05s = 0.1 beat.
    context.currentTime = 0.55;
    tick();
    assert.ok(Math.abs(positions.at(-1)! - 0.1) < 1e-4, `Expected position ~0.1 beat, got ${positions.at(-1)}`);
  } finally {
    player.dispose();
    globalThis.AudioContext = old;
  }
});

test('loop wrap skips multiple full loops during long stall and keeps overshoot', async () => {
  const old = globalThis.AudioContext;
  globalThis.AudioContext = FakeContext as unknown as typeof AudioContext;
  const positions: number[] = [];
  const player = new ScorePlayer({ onPosition: (b) => positions.push(b) });
  const tick = () => (player as unknown as { tick(): void }).tick();
  const loopScore: Score = {
    ...score,
    tempo: 120,
    totalBeats: 4,
    measures: [{ number: 1, startBeat: 0, duration: 4 }],
    parts: [{ ...score.parts[0], notes: [{ ...score.parts[0].notes[0], beat: 0, duration: 0.5 }] }],
  };
  try {
    player.load(loopScore);
    player.setLoop(0, 1, true);
    await player.play();
    const context = FakeContext.instance;
    // 2.65s at 120BPM (2 beats/sec) = 5.3 beats.
    // 5 full loops of 1 beat (2.5s). Boundary for 6th loop is at 2.5s.
    // Overshoot = 0.15s = 0.3 beats.
    context.currentTime = 2.65;
    tick();
    assert.ok(
      Math.abs(positions.at(-1)! - 0.3) < 1e-4,
      `Expected position ~0.3 beat across multiple loops, got ${positions.at(-1)}`,
    );
  } finally {
    player.dispose();
    globalThis.AudioContext = old;
  }
});

test('note scheduling correctly covers seek, loop, tempo, transpose, mute, repeats, and pause-resume with pre-sorted notes', async () => {
  const old = globalThis.AudioContext;
  globalThis.AudioContext = FakeContext as unknown as typeof AudioContext;
  const positions: number[] = [];
  const player = new ScorePlayer({ onPosition: (b) => positions.push(b) });
  const tick = () => (player as unknown as { tick(): void }).tick();

  // Create a large score with out-of-order authored notes (e.g. voice 2 after backup)
  // and long sustaining notes across measure boundaries.
  const notesP1: Score['parts'][0]['notes'] = [];
  const notesP2: Score['parts'][0]['notes'] = [];
  const measureCount = 50;
  for (let m = 0; m < measureCount; m++) {
    const start = m * 4;
    // Intentionally authored out of order: beat 2 before beat 0 in part array
    notesP1.push({
      id: `p1_m${m}_n2`,
      partId: 'p1',
      measure: m + 1,
      beat: start + 2,
      duration: 2,
      midi: 62,
      velocity: 80,
    });
    notesP1.push({ id: `p1_m${m}_n0`, partId: 'p1', measure: m + 1, beat: start, duration: 3, midi: 60, velocity: 80 }); // sustains across start+2
    notesP2.push({ id: `p2_m${m}_n0`, partId: 'p2', measure: m + 1, beat: start, duration: 4, midi: 48, velocity: 70 });
  }

  const complexScore: Score = {
    title: 'complex score',
    composer: '',
    tempo: 120,
    beatsPerMeasure: 4,
    totalBeats: measureCount * 4,
    warnings: [],
    xml: '',
    measures: Array.from({ length: measureCount }, (_, i) => ({ number: i + 1, startBeat: i * 4, duration: 4 })),
    parts: [
      { id: 'p1', name: 'Part 1', instrument: 0, notes: notesP1 },
      { id: 'p2', name: 'Part 2', instrument: 0, notes: notesP2 },
    ],
  };

  try {
    player.load(complexScore);
    await player.play();
    const ctx = FakeContext.instance;

    // 1. Initial play at t=0: schedules horizon [0, 1.3] (tempo 120 -> 0.65s = 1.3 beats)
    // Notes starting in [0, 1.3]:
    // p1: beat 0 (midi 60)
    // p2: beat 0 (midi 48)
    const initialSources = [...ctx.sources];
    assert.equal(initialSources.length, 2, 'Initial tick schedules 2 notes at beat 0');

    // 2. Seek into mid-note (beat 1.0, where beat 0 note of duration 3 is sustaining)
    player.seek(1.0);
    // Seeking cancels prior sources and resets schedule.
    // In tick at seek:
    // Sustaining notes across beat 1.0:
    // p1 beat 0 note (duration 3 -> ends at 3.0 > 1.0)
    // p2 beat 0 note (duration 4 -> ends at 4.0 > 1.0)
    const seekSources = ctx.sources.slice(initialSources.length);
    assert.equal(seekSources.length, 3, 'Seek schedules sustaining notes plus future notes in horizon');
    assert.equal(seekSources.filter((s) => s.offset > 0).length, 2, 'Two sustaining notes resume with interior offset');
    assert.equal(seekSources.filter((s) => s.offset === 0).length, 1, 'One future note starting at beat 2 in horizon');

    // 3. Tempo change at beat 1.5
    ctx.currentTime = 0.25;
    player.setTempo(60);
    // Tempo change resets schedule at current beat 1.5.
    // Sustaining notes across 1.5:
    // p1 beat 0 note (0..3) sustains across 1.5
    // p2 beat 0 note (0..4) sustains across 1.5
    tick();
    const tempoSources = ctx.sources.slice(initialSources.length + seekSources.length);
    assert.ok(tempoSources.length >= 2, 'Tempo change reschedules sustaining notes');

    // 4. Transpose change (+2 semitones)
    player.setTranspose(2);
    tick();
    const transposeSources = ctx.sources.slice(initialSources.length + seekSources.length + tempoSources.length);
    assert.ok(transposeSources.length >= 2, 'Transpose change reschedules sustaining notes with new pitch');

    // 5. Mute Part 2
    player.setMutedParts(['p2']);
    tick();
    const muteSources = ctx.sources.slice(
      initialSources.length + seekSources.length + tempoSources.length + transposeSources.length,
    );
    assert.equal(muteSources.length, 2, 'Only unmuted part 1 notes scheduled (sustaining + future note)');

    // 6. Loop with sustaining note across boundary
    // Loop beats 8..12
    player.setMutedParts([]);
    player.setLoop(8, 12, true);
    player.seek(8);
    tick();
    const loopSources = ctx.sources.slice(
      initialSources.length + seekSources.length + tempoSources.length + transposeSources.length + muteSources.length,
    );
    assert.equal(loopSources.length, 2, 'Loop start at beat 8 schedules beat 8 notes');

    // 7. Pause and resume
    player.pause();
    assert.equal(positions.at(-1), 8);
    await player.play();
    const resumeSources = ctx.sources.slice(
      initialSources.length +
        seekSources.length +
        tempoSources.length +
        transposeSources.length +
        muteSources.length +
        loopSources.length,
    );
    assert.equal(resumeSources.length, 2, 'Resume after pause schedules notes from paused position');
  } finally {
    player.dispose();
    globalThis.AudioContext = old;
  }
});
