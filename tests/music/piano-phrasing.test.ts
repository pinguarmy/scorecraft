import test from 'node:test';
import assert from 'node:assert/strict';
import { schedulePianoNote, PIANO_RELEASE_SECONDS, PIANO_LEGATO_RELEASE_SECONDS } from '../../src/music/piano';
import { scheduleInstrumentNote, type InstrumentId } from '../../src/music/instruments';
class Param {
  value = 0;
  events: Array<[string, number, number]> = [];
  setValueAtTime(value: number, at: number) {
    this.events.push(['set', value, at]);
  }
  linearRampToValueAtTime(value: number, at: number) {
    this.events.push(['linear', value, at]);
  }
}
class Node {
  gain = new Param();
  frequency = new Param();
  type = '';
  disconnected = false;
  connect() {}
  disconnect() {
    this.disconnected = true;
  }
}
class Source extends Node {
  playbackRate = new Param();
  buffer?: AudioBuffer;
  loop = false;
  onended: ((event: Event) => void) | null = null;
  starts: Array<[number, number]> = [];
  stops: Array<number | undefined> = [];
  start(at: number, offset: number) {
    this.starts.push([at, offset]);
  }
  stop(at?: number) {
    this.stops.push(at);
  }
}
function context() {
  const sources: Source[] = [];
  const gains: Node[] = [];
  const ctx = {
    currentTime: 0,
    createBufferSource() {
      const source = new Source();
      sources.push(source);
      return source;
    },
    createGain() {
      const gain = new Node();
      gains.push(gain);
      return gain;
    },
    createBiquadFilter() {
      return new Node();
    },
  };
  return { ctx: ctx as unknown as BaseAudioContext, sources, gains };
}
const samples = [{ midi: 60, buffer: { duration: 10, numberOfChannels: 2 } as AudioBuffer }];
test('explicit legato changes only bounded linear key-release, not onset keyoff or sample attack', () => {
  const a = context();
  const b = context();
  schedulePianoNote(a.ctx, {} as AudioNode, { samples }, 60, 80, 1, 0.5);
  schedulePianoNote(b.ctx, {} as AudioNode, { samples }, 60, 80, 1, 0.5, 0, { legato: true });
  assert.equal(PIANO_RELEASE_SECONDS, 0.35);
  assert.equal(PIANO_LEGATO_RELEASE_SECONDS, 0.5);
  assert.deepEqual(a.sources[0].starts, b.sources[0].starts);
  assert.deepEqual(b.sources[0].starts, [[1, 0]]);
  assert.deepEqual(a.gains[0].gain.events.slice(0, 2), b.gains[0].gain.events.slice(0, 2));
  assert.equal(b.gains[0].gain.events[1][2], 1.5, 'keyoff remains written duration');
  assert.deepEqual(a.gains[0].gain.events.at(-1), ['linear', 0, 1.85]);
  assert.deepEqual(b.gains[0].gain.events.at(-1), ['linear', 0, 2]);
  assert.equal(a.sources[0].stops[0], 1.85);
  assert.equal(b.sources[0].stops[0], 2);
});
test('only selected piano presets extend release; guitar bass strings and false legato retain .35', () => {
  for (const id of [
    'piano-bright',
    'piano-warm',
    'guitar-acoustic',
    'guitar-electric',
    'bass-electric',
    'strings',
  ] as InstrumentId[]) {
    const h = context();
    scheduleInstrumentNote(h.ctx, {} as AudioNode, { id, samples }, { midi: 60, velocity: 80, legato: true }, 0, 1);
    assert.equal(h.sources[0].stops[0], id.startsWith('piano-') ? 1.5 : 1.35, id);
  }
  const h = context();
  scheduleInstrumentNote(
    h.ctx,
    {} as AudioNode,
    { id: 'piano-warm', samples },
    { midi: 60, velocity: 80, legato: false },
    0,
    1,
  );
  assert.equal(h.sources[0].stops[0], 1.35);
});
test('ending one legato voice never disconnects its neighbour and explicit stop cancels future sources', () => {
  const h = context();
  const destination = new Node();
  const first = scheduleInstrumentNote(
    h.ctx,
    destination as unknown as AudioNode,
    { id: 'piano-bright', samples },
    { midi: 60, velocity: 80, legato: true },
    0,
    0.5,
  )!;
  const next = scheduleInstrumentNote(
    h.ctx,
    destination as unknown as AudioNode,
    { id: 'piano-bright', samples },
    { midi: 62, velocity: 80 },
    0.5,
    0.5,
  )!;
  h.sources[0].onended?.(new Event('ended'));
  assert(!destination.disconnected);
  assert(!h.sources[1].disconnected);
  next.stop();
  first.stop();
  assert(h.sources.every((source) => source.stops.includes(undefined)));
});
