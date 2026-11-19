import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPianoBank, schedulePianoNote, PIANO_MASTER_GAIN, PIANO_RELEASE_SECONDS, type PianoBank } from '../../src/music/piano';
import { ScorePlayer } from '../../src/music/player';
import type { Score } from '../../src/music/types';
class Param {
  value = 0; events: Array<[string, number, number]> = [];
  setValueAtTime(value: number, at: number) { this.events.push(['set', value, at]); }
  linearRampToValueAtTime(value: number, at: number) { this.events.push(['linear', value, at]); }
  exponentialRampToValueAtTime(value: number, at: number) { this.events.push(['exp', value, at]); }
}
class Gain { gain = new Param(); disconnected = false; connect() {} disconnect() { this.disconnected = true; } }
class Source {
  buffer?: AudioBuffer; playbackRate = new Param(); loop = false; onended?: (event: Event) => void;
  starts: Array<[number, number]> = []; stops: Array<number | undefined> = []; disconnected = false;
  connect() {} disconnect() { this.disconnected = true; }
  start(at: number, offset: number) { this.starts.push([at, offset]); }
  stop(at?: number) { this.stops.push(at); }
}
class Context {
  static instance: Context; static rate = 48000;
  sampleRate = Context.rate; currentTime = 0; destination = {};
  gains: Gain[] = []; sources: Source[] = []; oscillators = 0;
  constructor() { Context.instance = this; }
  async resume() {} async close() {}
  createGain() { const gain = new Gain(); this.gains.push(gain); return gain; }
  createBiquadFilter() { return { type: '', frequency: new Param(), gain: new Param(), connect() {}, disconnect() {} }; }
  createBufferSource() { const source = new Source(); this.sources.push(source); return source; }
  createOscillator() { this.oscillators++; throw new Error('Unexpected instrument oscillator'); }
  async decodeAudioData() { return pcm; }
}
const pcm = { length: 480000, duration: 10, numberOfChannels: 2 } as AudioBuffer;
const score: Score = { title: '', composer: '', tempo: 120, beatsPerMeasure: 4, totalBeats: 4, measures: [{ number: 1, startBeat: 0, duration: 4 }], warnings: [], xml: '', parts: [{ id: 'p', name: 'p', instrument: 0, notes: [{ id: 'n', partId: 'p', measure: 1, beat: 0, duration: 4, midi: 60, velocity: 80 }] }] };
function asContext(context: Context) { return context as unknown as BaseAudioContext; }

test('local bank uses fixed same-origin paths, bounded concurrency and reusable decoded stereo buffers', async () => {
  const native = globalThis.fetch; let active = 0; let maximum = 0; const urls: string[] = [];
  globalThis.fetch = async (url, init) => {
    urls.push(String(url)); active++; maximum = Math.max(maximum, active);
    assert.equal(init?.redirect, 'error'); assert.equal(init?.credentials, 'same-origin');
    await new Promise<void>(resolve => setImmediate(resolve)); active--;
    return new Response(new Uint8Array([1, 2, 3]));
  };
  try {
    const first = new Context(); const bank = await loadPianoBank(asContext(first));
    assert.equal(bank.samples.length, 30); assert.equal(maximum, 4); assert.equal(urls.length, 30);
    assert(urls.every(url => /^\/audio\/piano\/[A-Za-z0-9]+\.mp3$/.test(url)));
    assert.equal(bank.samples[0].midi, 21); assert.equal(bank.samples.at(-1)!.midi, 108);
    assert(bank.samples.every(sample => sample.buffer === pcm && sample.buffer.numberOfChannels === 2));
    assert.equal(await loadPianoBank(asContext(new Context())), bank); assert.equal(urls.length, 30);
  } finally { globalThis.fetch = native; }
});
test('failed bank is evicted for retry and invalid decoded buffers are rejected', async () => {
  const native = globalThis.fetch; globalThis.fetch = async () => new Response('missing', { status: 404 });
  const context = new Context(); context.sampleRate = 32000;
  try {
    await assert.rejects(loadPianoBank(asContext(context)), /加载失败/);
    globalThis.fetch = async () => new Response(new Uint8Array([1]));
    assert.equal((await loadPianoBank(asContext(context))).samples.length, 30);
    const bad = new Context(); bad.sampleRate = 22050; bad.decodeAudioData = async () => ({ ...pcm, length: 0 } as AudioBuffer);
    await assert.rejects(loadPianoBank(asContext(bad)), /无法解码/);
  } finally { globalThis.fetch = native; }
});
test('scheduler selects closest key, pitch-shifts original stereo and retains natural attack plus release', () => {
  const context = new Context(); const bank: PianoBank = { samples: [{ midi: 60, buffer: pcm }, { midi: 63, buffer: { ...pcm } as AudioBuffer }] };
  const source = schedulePianoNote(asContext(context), {} as AudioNode, bank, 61, 100, 1, 2) as unknown as Source;
  assert.equal(source.buffer, pcm); assert.equal(source.playbackRate.value, 2 ** (1 / 12)); assert.equal(source.loop, false);
  assert.deepEqual(source.starts, [[1, 0]]); assert.deepEqual(source.stops, [3 + PIANO_RELEASE_SECONDS]);
  assert.equal(context.gains[0].gain.events[0][0], 'set'); assert.equal(context.gains[0].gain.events[0][1], Math.pow(100 / 127, 1.5));
  assert.equal(context.gains[0].gain.events[0][2], 1); assert.equal(context.gains[0].gain.events.filter(([kind]) => kind === 'linear').length, 1);
  source.onended?.(new Event('ended')); assert(source.disconnected); assert(context.gains[0].disconnected);
  const offset = schedulePianoNote(asContext(context), {} as AudioNode, bank, 60, 80, 0, 1, .5) as unknown as Source;
  assert.deepEqual(offset.starts, [[0, .5]]); assert.equal(context.gains[1].gain.events[0][1], 0); assert.equal(context.gains[1].gain.events[1][2], .004);
  assert.equal(PIANO_MASTER_GAIN, .25); assert.equal(context.oscillators, 0);
});
test('loading cancellation is immediate idle and cannot start samples or count-in after readiness', async () => {
  const nativeFetch = globalThis.fetch; const nativeAudio = globalThis.AudioContext;
  globalThis.AudioContext = Context as unknown as typeof AudioContext;
  try {
    for (const [index, action] of ['pause', 'stop', 'load', 'dispose', 'seek'].entries()) {
      Context.rate = 50000 + index;
      let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
      globalThis.fetch = async () => { await blocked; return new Response(new Uint8Array([1])); };
      const states: string[] = []; const counts: Array<number | null> = [];
      const player = new ScorePlayer({ onAudioState: state => states.push(state), onCountIn: count => counts.push(count) });
      player.load(score); player.setCountIn(true); const pending = player.play();
      await new Promise<void>(resolve => setImmediate(resolve));
      assert.deepEqual(states, ['loading']); assert.equal(Context.instance.sources.length, 0); assert.deepEqual(counts, []);
      if (action === 'load') player.load(score); else if (action === 'seek') player.seek(2); else player[action as 'pause' | 'stop' | 'dispose']();
      assert.deepEqual(states, ['loading', 'idle'], action); release(); await pending;
      assert.deepEqual(states, ['loading', 'idle']); assert.equal(Context.instance.sources.length, 0); assert.equal(Context.instance.oscillators, 0); assert.deepEqual(counts, []);
      player.dispose();
    }
  } finally { globalThis.fetch = nativeFetch; globalThis.AudioContext = nativeAudio; }
});
test('natural completion lets recorded release finish while explicit stop cancels all sources', async () => {
  const nativeFetch = globalThis.fetch; const nativeAudio = globalThis.AudioContext;
  Context.rate = 56000; globalThis.AudioContext = Context as unknown as typeof AudioContext;
  globalThis.fetch = async () => new Response(new Uint8Array([1]));
  const states: boolean[] = []; const player = new ScorePlayer({ onState: state => states.push(state) });
  try {
    player.load(score); await player.play(); const source = Context.instance.sources[0];
    Context.instance.currentTime = 2; (player as unknown as { tick(): void }).tick();
    assert.equal(states.at(-1), false); assert(!source.stops.includes(undefined), 'natural end must not cut release');
    assert.equal(source.stops[0], 2.35); player.stop(); assert(source.stops.includes(undefined));
  } finally { player.dispose(); globalThis.fetch = nativeFetch; globalThis.AudioContext = nativeAudio; }
});

test('player reports sample failure, never synthesizes fallback, and Play can retry successfully', async () => {
  const nativeFetch = globalThis.fetch; const nativeAudio = globalThis.AudioContext;
  Context.rate = 57000; globalThis.AudioContext = Context as unknown as typeof AudioContext;
  const states: string[] = []; const player = new ScorePlayer({ onAudioState: state => states.push(state) });
  try {
    globalThis.fetch = async () => new Response('missing', { status: 404 }); player.load(score);
    await assert.rejects(player.play(), /加载失败/); assert.deepEqual(states, ['loading', 'error']); assert.equal(Context.instance.sources.length, 0); assert.equal(Context.instance.oscillators, 0);
    globalThis.fetch = async () => new Response(new Uint8Array([1])); await player.play();
    assert.deepEqual(states, ['loading', 'error', 'loading', 'ready']); assert.equal(Context.instance.sources.length, 1); assert.equal(Context.instance.oscillators, 0);
    player.stop(); assert(Context.instance.sources.every(source => source.stops.includes(undefined)));
  } finally { player.dispose(); globalThis.fetch = nativeFetch; globalThis.AudioContext = nativeAudio; }
});
