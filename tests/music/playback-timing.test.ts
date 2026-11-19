import test from 'node:test';
import assert from 'node:assert/strict';
import { schedulePianoNote, PIANO_RELEASE_SECONDS } from '../../src/music/piano';
import { scheduleInstrumentNote } from '../../src/music/instruments';

class EventLogParam {
  events: Array<[string, number, number?]> = [];
  value = 0;
  setValueAtTime(val: number, time: number) { this.events.push(['set', val, time]); this.value = val; }
  linearRampToValueAtTime(val: number, time: number) { this.events.push(['linear', val, time]); this.value = val; }
  exponentialRampToValueAtTime(val: number, time: number) { this.events.push(['exponential', val, time]); this.value = val; }
}

class FakeAudioNode {
  connect() {}
  disconnect() {}
}

class FakeAudioBufferSourceNode extends FakeAudioNode {
  buffer?: AudioBuffer;
  playbackRate = new EventLogParam();
  loop = false;
  onended?: (event?: any) => void;
  starts: Array<[number, number]> = [];
  stops: number[] = [];
  start(when: number, offset = 0) { this.starts.push([when, offset]); }
  stop(when: number) { this.stops.push(when); }
}

class FakeGainNode extends FakeAudioNode {
  gain = new EventLogParam();
}

class FakeOscillatorNode extends FakeAudioNode {
  frequency = new EventLogParam();
  type = '';
  onended?: (event?: any) => void;
  starts: number[] = [];
  stops: number[] = [];
  start(when: number) { this.starts.push(when); }
  stop(when: number) { this.stops.push(when); }
}

class FakeTimingContext {
  sampleRate = 44100;
  currentTime = 0;
  destination = new FakeAudioNode();
  sources: FakeAudioBufferSourceNode[] = [];
  oscillators: FakeOscillatorNode[] = [];
  gains: FakeGainNode[] = [];

  createBufferSource() {
    const s = new FakeAudioBufferSourceNode();
    this.sources.push(s);
    return s;
  }
  createGain() {
    const g = new FakeGainNode();
    this.gains.push(g);
    return g;
  }
  createOscillator() {
    const o = new FakeOscillatorNode();
    this.oscillators.push(o);
    return o;
  }
  createBiquadFilter() {
    return {
      type: '',
      frequency: new EventLogParam(),
      gain: new EventLogParam(),
      connect() {},
      disconnect() {},
    };
  }
}

const pcmBuffer = {
  length: 441000,
  duration: 10,
  numberOfChannels: 2,
  sampleRate: 44100,
  getChannelData: () => new Float32Array(441000),
} as unknown as AudioBuffer;

test('schedulePianoNote preserves absolute end time (at + duration) on late start and adds offset', () => {
  const ctx = new FakeTimingContext();
  const bank = { samples: [{ midi: 60, buffer: pcmBuffer }] };

  // Note was scheduled at t=1.0 with duration 2.0 (intended end = 3.0)
  // Clock is already at t=1.5 (late by 0.5s)
  ctx.currentTime = 1.5;
  const returnedSource = schedulePianoNote(ctx as unknown as BaseAudioContext, new FakeAudioNode() as unknown as AudioNode, bank, 60, 100, 1.0, 2.0);

  assert.ok(returnedSource);
  const source = ctx.sources[0];
  // Must start at current time 1.5
  assert.equal(source.starts[0][0], 1.5);
  // Offset into buffer must include the 0.5s delay
  assert.equal(source.starts[0][1], 0.5);
  // Absolute note-off must be at at + duration = 3.0, NOT start + duration = 3.5
  // Stop is noteOff + PIANO_RELEASE_SECONDS = 3.0 + 0.35 = 3.35
  assert.equal(source.stops[0], 3.0 + PIANO_RELEASE_SECONDS);
  const gainEvents = ctx.gains[0].gain.events;
  const noteOffSet = gainEvents.find(e => e[0] === 'set' && e[2] === 3.0);
  assert.ok(noteOffSet, 'gain must set note-off value at at + duration = 3.0');
});

test('schedulePianoNote skips completely expired notes without creating audio nodes', () => {
  const ctx = new FakeTimingContext();
  const bank = { samples: [{ midi: 60, buffer: pcmBuffer }] };

  // Note scheduled at t=1.0 with duration 1.0 (ended at t=2.0)
  // Clock is at t=2.5 (completely expired)
  ctx.currentTime = 2.5;
  const source = schedulePianoNote(ctx as unknown as BaseAudioContext, new FakeAudioNode() as unknown as AudioNode, bank, 60, 100, 1.0, 1.0);

  assert.equal(source, null, 'completely expired note must return null');
  assert.equal(ctx.sources.length, 0, 'no buffer source created');
  assert.equal(ctx.gains.length, 0, 'no gain node created');
});

test('scheduleInstrumentNote synth-pad preserves absolute end time on late start and skips expired notes', () => {
  const ctx = new FakeTimingContext();
  const synthBank = { id: 'synth-pad' as const };

  // Late by 0.4s on 1.0s note: at=1.0, duration=1.0, currentTime=1.4
  ctx.currentTime = 1.4;
  const voice = scheduleInstrumentNote(ctx as unknown as BaseAudioContext, new FakeAudioNode() as unknown as AudioNode, synthBank, { midi: 60, velocity: 80 }, 1.0, 1.0);
  assert.ok(voice);
  // Oscillators must start at 1.4
  assert.equal(ctx.oscillators[0].starts[0], 1.4);
  // Note-off at at + duration = 2.0. Stop at 2.0 + 0.35 = 2.35 (NOT 1.4 + 1.0 + 0.35 = 2.75)
  assert.equal(ctx.oscillators[0].stops[0], 2.35);

  // Completely expired synth note: at=1.0, duration=1.0, currentTime=2.5
  ctx.currentTime = 2.5;
  const expiredVoice = scheduleInstrumentNote(ctx as unknown as BaseAudioContext, new FakeAudioNode() as unknown as AudioNode, synthBank, { midi: 60, velocity: 80 }, 1.0, 1.0);
  assert.equal(expiredVoice, null);
});
