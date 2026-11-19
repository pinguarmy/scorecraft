// Playwright-only instrumentation: observe the actual Web Audio output digitally.
// Inject with page.addInitScript({ path: 'scripts/inspect-audio.mjs' }) before navigation.
(() => {
  window.__scorecraftAudio = { meters: [], oscillatorStarts: 0, events: [], contexts: [] };
  const nativeConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function (destination, ...rest) {
    if (destination instanceof AudioDestinationNode) {
      const analyser = this.context.createAnalyser();
      analyser.fftSize = 2048;
      nativeConnect.call(this, analyser);
      window.__scorecraftAudio.meters.push(analyser);
      nativeConnect.call(analyser, destination, ...rest);
      return destination;
    }
    return nativeConnect.call(this, destination, ...rest);
  };
  const nativeStart = OscillatorNode.prototype.start;
  OscillatorNode.prototype.start = function (...args) {
    const data = window.__scorecraftAudio;
    data.oscillatorStarts += 1;
    if (!data.contexts.includes(this.context)) data.contexts.push(this.context);
    data.events.push({ id: data.oscillatorStarts, type: this.type, frequency: this.frequency.value, scheduledAt: args[0] ?? this.context.currentTime, observedAt: this.context.currentTime, stoppedAt: null });
    this.__scorecraftEvent = data.events.at(-1);
    return nativeStart.apply(this, args);
  };
  const nativeStop = OscillatorNode.prototype.stop;
  OscillatorNode.prototype.stop = function (...args) {
    if (this.__scorecraftEvent) this.__scorecraftEvent.stoppedAt = args[0] ?? this.context.currentTime;
    return nativeStop.apply(this, args);
  };
  const nativeBufferStart = AudioBufferSourceNode.prototype.start;
  const nativeBufferStop = AudioBufferSourceNode.prototype.stop;
  AudioBufferSourceNode.prototype.start = function (...args) {
    const data = window.__scorecraftAudio;
    if (!data.contexts.includes(this.context)) data.contexts.push(this.context);
    const event = { id: `sample-${data.events.length}`, type: 'sample', scheduledAt: args[0] ?? this.context.currentTime, observedAt: this.context.currentTime, stoppedAt: null, rate: this.playbackRate.value, channels: this.buffer?.numberOfChannels, bufferLength: this.buffer?.length, duration: this.buffer?.duration, offset: args[1] ?? 0, offline: this.context instanceof OfflineAudioContext };
    data.events.push(event); this.__scorecraftEvent = event;
    return nativeBufferStart.apply(this, args);
  };
  AudioBufferSourceNode.prototype.stop = function (...args) {
    if (this.__scorecraftEvent) this.__scorecraftEvent.stoppedAt = args[0] ?? this.context.currentTime;
    return nativeBufferStop.apply(this, args);
  };
  window.__scorecraftAudioRms = () => {
    let max = 0;
    for (const meter of window.__scorecraftAudio.meters) {
      const buffer = new Float32Array(meter.fftSize);
      meter.getFloatTimeDomainData(buffer);
      const rms = Math.sqrt(buffer.reduce((sum, value) => sum + value * value, 0) / buffer.length);
      max = Math.max(max, rms);
    }
    return max;
  };
})();
