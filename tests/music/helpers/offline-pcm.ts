// Test-only PCM fixtures and a tiny deterministic Web Audio graph mock.
// This does not decode MP3 or evaluate real piano quality.
class Param {
  value = 1;
  events: { time: number; value: number; ramp: boolean }[] = [];
  setValueAtTime(value: number, time: number) { this.events.push({ value, time, ramp: false }); }
  linearRampToValueAtTime(value: number, time: number) { this.events.push({ value, time, ramp: true }); }
  exponentialRampToValueAtTime(value: number, time: number) { this.events.push({ value, time, ramp: true }); }
  at(time: number) {
    let prior = { time: 0, value: this.value, ramp: false };
    for (const event of this.events) {
      if (event.time > time) return event.ramp ? prior.value + (event.value - prior.value) * (time - prior.time) / (event.time - prior.time) : prior.value;
      prior = event;
    }
    return prior.value;
  }
}
class Node {
  destination?: Node;
  connect(destination: Node) { this.destination = destination; return destination; }
  disconnect() { this.destination = undefined; }
}
class Gain extends Node { gain = new Param(); }
class Filter extends Node { type = ''; frequency = new Param(); gain = new Param(); }
class Oscillator extends Node {
  type = ''; frequency = new Param(); at = 0; until = Infinity; onended?: (event: Event) => void;
  start(at: number) { this.at = at; }
  stop(until = 0) { this.until = until; }
}
export class TestBuffer {
  readonly channels: Float32Array[];
  constructor(public numberOfChannels: number, public length: number, public sampleRate: number) { this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length)); }
  get duration() { return this.length / this.sampleRate; }
  getChannelData(channel: number) { return this.channels[channel]; }
}
class Source extends Node {
  buffer?: TestBuffer; playbackRate = new Param(); loop = false; at = 0; offset = 0; until = Infinity; onended?: () => void;
  start(at: number, offset = 0) { this.at = at; this.offset = offset; }
  stop(until: number) { this.until = until; }
}
export class TestOfflineContext {
  static created = 0;
  static contexts: TestOfflineContext[] = [];
  currentTime = 0; destination = new Node(); sources: Source[] = []; oscillators: Oscillator[] = []; filters: Filter[] = [];
  constructor(public numberOfChannels: number, public length: number, public sampleRate: number) { TestOfflineContext.created++; TestOfflineContext.contexts.push(this); }
  createGain() { return new Gain(); }
  createBiquadFilter() { const filter = new Filter(); this.filters.push(filter); return filter; }
  createOscillator() { const oscillator = new Oscillator(); this.oscillators.push(oscillator); return oscillator; }
  createBuffer(channels: number, length: number, rate: number) { return new TestBuffer(channels, length, rate); }
  createBufferSource() { const source = new Source(); this.sources.push(source); return source; }
  async decodeAudioData(bytes: ArrayBuffer) {
    const key = new Uint8Array(bytes)[0];
    const buffer = new TestBuffer(2, 2205, this.sampleRate);
    for (let i = 0; i < buffer.length; i++) { buffer.channels[0][i] = (i % 37 < 18 ? .4 : -.4) * (1 - i / buffer.length) * (1 + key / 100); buffer.channels[1][i] = buffer.channels[0][i] * -.6; }
    return buffer;
  }
  async startRendering() {
    const output = new TestBuffer(this.numberOfChannels, this.length, this.sampleRate);
    for (const source of this.sources) {
      const buffer = source.buffer; if (!buffer) continue;
      const start = Math.max(0, Math.ceil(source.at * this.sampleRate));
      const end = Math.min(this.length, Math.ceil(Math.min(source.until, source.at + (buffer.duration - source.offset) / source.playbackRate.value) * this.sampleRate));
      for (let frame = start; frame < end; frame++) {
        const time = frame / this.sampleRate;
        const sample = Math.floor((source.offset + (time - source.at) * source.playbackRate.value) * buffer.sampleRate);
        let gain = 1; let node = source.destination;
        while (node) { if (node instanceof Gain) gain *= node.gain.at(time); node = node.destination; }
        for (let channel = 0; channel < this.numberOfChannels; channel++) output.channels[channel][frame] += (buffer.channels[channel % buffer.numberOfChannels][sample] || 0) * gain;
      }
    }
    return output;
  }
}
export function installTestOfflinePcm() {
  const oldContext = globalThis.OfflineAudioContext; const oldFetch = globalThis.fetch;
  globalThis.OfflineAudioContext = TestOfflineContext as unknown as typeof OfflineAudioContext;
  const keys = ['A0', 'C1', 'Ds1', 'Fs1', 'A1', 'C2', 'Ds2', 'Fs2', 'A2', 'C3', 'Ds3', 'Fs3', 'A3', 'C4', 'Ds4', 'Fs4', 'A4', 'C5', 'Ds5', 'Fs5', 'A5', 'C6', 'Ds6', 'Fs6', 'A6', 'C7', 'Ds7', 'Fs7', 'A7', 'C8'];
  globalThis.fetch = (async (url: string | URL | Request) => {
    const match = String(url).match(/^\/audio\/(?:piano|instruments\/(?:guitar-acoustic|guitar-electric|bass-electric|strings))\/([^/]+)\.mp3$/);
    if (!match || !/^[A-G]s?\d$/.test(match[1])) throw new Error(`Unexpected nonlocal test sample URL: ${url}`);
    return { ok: true, arrayBuffer: async () => new Uint8Array([keys.indexOf(match[1]) + 2]).buffer } as Response;
  }) as typeof fetch;
  return () => { globalThis.OfflineAudioContext = oldContext; globalThis.fetch = oldFetch; };
}
