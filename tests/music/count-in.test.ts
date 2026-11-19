import test from 'node:test';
import assert from 'node:assert/strict';
import { ScorePlayer } from '../../src/music/player';
import type { Score } from '../../src/music/types';

class Param { value = 0; setValueAtTime() {} linearRampToValueAtTime() {} exponentialRampToValueAtTime() {} }
class Gain { gain = new Param(); connect() {} disconnect() {} }
class Oscillator {
  type = ''; frequency = new Param(); onended?: () => void;
  starts: number[] = []; stops: Array<number | undefined> = [];
  connect() {} disconnect() {}
  start(at: number) { this.starts.push(at); }
  stop(at?: number) { this.stops.push(at); }
}
class SampleSource {
  buffer?: AudioBuffer; playbackRate = new Param(); loop = false; onended?: () => void;
  starts: number[] = []; stops: Array<number | undefined> = [];
  connect() {} disconnect() {} start(at: number) { this.starts.push(at); } stop(at?: number) { this.stops.push(at); }
}
class Clock {
  static instance: Clock;
  static pendingResume: Promise<void> | undefined;
  sampleRate = 44100; currentTime = 0; destination = {}; voices: Oscillator[] = []; sources: SampleSource[] = []; closed = false;
  async decodeAudioData() { return { length: 441000, duration: 10, numberOfChannels: 2 } as AudioBuffer; }
  createBufferSource() { const source = new SampleSource(); this.sources.push(source); return source; }
  constructor() { Clock.instance = this; }
  async resume() { await Clock.pendingResume; }
  async close() { this.closed = true; }
  createGain() { return new Gain(); }
  createBiquadFilter() { return { type: '', frequency: new Param(), gain: new Param(), connect() {}, disconnect() {} }; }
  createOscillator() { const voice = new Oscillator(); this.voices.push(voice); return voice; }
}
const nativeFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]));
test.after(() => { globalThis.fetch = nativeFetch; });
const score: Score = {
  title: 'count-in test', composer: '', tempo: 120, beatsPerMeasure: 4, totalBeats: 8, warnings: [], xml: '',
  measures: [{ number: 1, startBeat: 0, duration: 4 }, { number: 2, startBeat: 4, duration: 4 }],
  parts: [{ id: 'piano', name: 'piano', instrument: 0, notes: [
    { id: 'n1', partId: 'piano', measure: 1, beat: 0, duration: 4, midi: 60, velocity: 80 },
    { id: 'n2', partId: 'piano', measure: 2, beat: 4, duration: 4, midi: 64, velocity: 80 },
  ] }],
};
function harness(input = score) {
  const original = globalThis.AudioContext;
  globalThis.AudioContext = Clock as unknown as typeof AudioContext;
  const positions: number[] = []; const states: boolean[] = []; const counts: Array<number | null> = [];
  const player = new ScorePlayer({ onPosition: b => positions.push(b), onState: s => states.push(s), onCountIn: n => counts.push(n) });
  player.load(input);
  const tick = (time: number) => { Clock.instance.currentTime = time; (player as unknown as { tick(): void }).tick(); };
  return { player, positions, states, counts, tick, close() { player.dispose(); globalThis.AudioContext = original; Clock.pendingResume = undefined; } };
}
const music = () => Clock.instance.sources;
const clicks = () => Clock.instance.voices.filter(v => v.type === 'square');

test('default remains immediate music without count-in', async () => {
  const h = harness();
  try { await h.player.play(); assert.equal(music().length, 1); assert.equal(clicks().length, 0); assert.deepEqual(h.counts, []); }
  finally { h.close(); }
});
test('one bar uses audio clock clicks with metronome off, held source, exact music handoff and beat-only callbacks', async () => {
  const h = harness();
  try {
    h.player.setCountIn(true); await h.player.play();
    assert.equal(h.states.at(-1), true); assert.deepEqual(h.counts, [4]); assert.equal(music().length, 0);
    h.tick(.4); h.tick(.5); h.tick(.9); h.tick(1); h.tick(1.4); h.tick(1.5); h.tick(1.99);
    assert.deepEqual(clicks().map(v => v.starts[0]), [0, .5, 1, 1.5]);
    assert.equal(music().length, 0); assert.equal(h.positions.at(-1), 0); assert.deepEqual(h.counts, [4, 3, 2, 1]);
    h.tick(2); assert.deepEqual(h.counts, [4, 3, 2, 1, null]); assert.equal(music()[0].starts[0], 2); assert.equal(h.positions.at(-1), 0);
    h.tick(2.25); assert.equal(h.positions.at(-1), .5); assert.equal(clicks().length, 4);
  } finally { h.close(); }
});
test('fractional source bar and seek choose containing source duration, truncating final interval', async () => {
  const h = harness({ ...score, totalBeats: 6.5, measures: [{ number: 1, startBeat: 0, duration: 3 }, { number: 2, startBeat: 3, duration: 3.5 }] });
  try {
    h.player.seek(4); h.player.setCountIn(true); await h.player.play();
    assert.deepEqual(h.counts, [3.5]); h.tick(.5); h.tick(1); h.tick(1.5); h.tick(1.749);
    assert.equal(h.positions.at(-1), 4); assert.equal(music().length, 0);
    assert.deepEqual(h.counts, [3.5, 2.5, 1.5, .5]);
    assert.deepEqual(clicks().map(v => v.starts[0]), [0, .5, 1, 1.5]);
    h.tick(1.75); assert.equal(h.counts.at(-1), null); assert.equal(music()[0].starts[0], 1.75); assert.equal(h.positions.at(-1), 4);
  } finally { h.close(); }
});
test('short final fractional click is bounded by the exact bar deadline', async () => {
  const h = harness({ ...score, totalBeats: 1.01, measures: [{ number: 1, startBeat: 0, duration: 1.01 }] });
  try {
    h.player.setCountIn(true); await h.player.play(); h.tick(.49);
    assert.equal(clicks().length, 2); assert.equal(clicks()[1].starts[0], .5);
    assert.equal(clicks()[1].stops[0], .505); assert.equal(music().length, 0);
    h.tick(.505); assert.equal(music()[0].starts[0], .505);
  } finally { h.close(); }
});

test('pause stop seek load and dispose cancel clicks and never start music past old deadline', async () => {
  for (const action of ['pause', 'stop', 'seek', 'load', 'dispose'] as const) {
    const h = harness();
    try {
      h.player.setCountIn(true); await h.player.play(); h.tick(.6);
      if (action === 'seek') h.player.seek(2);
      else if (action === 'load') h.player.load(score);
      else h.player[action]();
      const callbacks = [h.counts.length, h.states.length, h.positions.length];
      h.tick(10);
      assert.equal(music().length, 0, action); assert.equal(h.states.at(-1), false, action); assert.equal(h.counts.at(-1), null, action);
      assert(clicks().every(v => v.stops.includes(undefined)), `${action}: all scheduled clicks stopped`);
      assert.deepEqual([h.counts.length, h.states.length, h.positions.length], callbacks, `${action}: no delayed callbacks`);
      if (action === 'seek') assert.equal(h.positions.at(-1), 2);
    } finally { h.close(); }
  }
});
test('changed settings cancel while normalized no-op setters preserve counting', async () => {
  const h = harness();
  try {
    h.player.setCountIn(true); h.player.setMutedParts(['unheard']); await h.player.play();
    h.player.setTempo(120); h.player.setTranspose(.1); h.player.setMutedParts(['unheard', 'unheard']);
    h.player.setMetronome(false); h.player.setLoop(0, 8, false); h.player.setFollowRepeats(true); h.player.setCountIn(true);
    h.tick(.5); assert.deepEqual(h.counts, [4, 3]); assert.equal(h.states.at(-1), true);
  } finally { h.close(); }
  const settings = [
    (p: ScorePlayer) => p.setTempo(160), (p: ScorePlayer) => p.setTranspose(2),
    (p: ScorePlayer) => p.setMutedParts(['piano']), (p: ScorePlayer) => p.setMetronome(true),
    (p: ScorePlayer) => p.setLoop(1, 7, false), (p: ScorePlayer) => p.setFollowRepeats(false),
    (p: ScorePlayer) => p.setCountIn(false),
  ];
  for (const change of settings) {
    const x = harness();
    try { x.player.setCountIn(true); await x.player.play(); x.tick(.5); change(x.player); x.tick(10); assert.equal(music().length, 0); assert.equal(x.states.at(-1), false); assert.equal(x.counts.at(-1), null); }
    finally { x.close(); }
  }
});
test('same instrument map keeps count-in but actual instrument change cancels until next Play', async () => {
  const h = harness();
  try {
    h.player.setCountIn(true); await h.player.play(); h.tick(.5);
    h.player.setPartInstruments({ piano: 'piano-bright' }); assert.equal(h.states.at(-1), true); assert.equal(h.counts.at(-1), 3);
    h.player.setPartInstruments({ piano: 'piano-warm' }); assert.equal(h.states.at(-1), false); assert.equal(h.counts.at(-1), null);
    h.tick(10); assert.equal(music().length, 0); await h.player.play(); assert.equal(h.counts.at(-1), 4);
  } finally { h.close(); }
});

test('explicit resume counts afresh, music-time toggle does not interrupt and loop wrap does not recount', async () => {
  const h = harness();
  try {
    h.player.setLoop(0, 4, true); h.player.setCountIn(true); await h.player.play(); h.tick(.5); h.player.pause();
    await h.player.play(); assert.equal(h.counts.at(-1), 4); h.tick(2.5); assert.equal(music().length, 1);
    const before = h.counts.length; h.player.setCountIn(false); h.player.setCountIn(true);
    assert.equal(h.states.at(-1), true); assert.equal(h.counts.length, before);
    h.tick(4.5); assert.equal(h.positions.at(-1), 0); assert.equal(h.counts.length, before); assert.equal(h.states.at(-1), true);
    h.player.pause(); await h.player.play(); assert.equal(h.counts.at(-1), 4);
  } finally { h.close(); }
});
test('count-in pause and resume retain second repeat passage until natural completion', async () => {
  const repeated: Score = { ...score, playback: { expanded: true, totalBeats: 16, segments: [{ sourceStart: 0, sourceEnd: 8, playStart: 0 }, { sourceStart: 0, sourceEnd: 8, playStart: 8 }] } };
  const h = harness(repeated);
  try {
    await h.player.play(); h.tick(4.5); h.player.pause(); assert.equal(h.positions.at(-1), 1);
    h.player.setCountIn(true); await h.player.play(); h.tick(5); h.player.pause(); assert.equal(h.positions.at(-1), 1);
    await h.player.play(); h.tick(7); assert.equal(h.positions.at(-1), 1);
    h.tick(10.5); assert.equal(h.positions.at(-1), 8); assert.equal(h.states.at(-1), false);
  } finally { h.close(); }
});
test('async audio resume is generation guarded and dispose leaks no later callbacks', async () => {
  let release!: () => void; Clock.pendingResume = new Promise<void>(resolve => { release = resolve; });
  const h = harness();
  try {
    h.player.setCountIn(true); const pending = h.player.play(); h.player.dispose();
    const callbacks = h.counts.length + h.states.length + h.positions.length; release(); await pending;
    assert.equal(Clock.instance.voices.length, 0); assert.equal(h.counts.length + h.states.length + h.positions.length, callbacks);
    await h.player.play(); assert.equal(Clock.instance.voices.length, 0);
  } finally { h.close(); }
});
