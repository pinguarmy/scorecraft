/** Local Salamander Yamaha C5 recordings. Asset attribution lives in /audio/piano/README.md. */
export type PianoBank = { samples: Array<{ midi: number; buffer: AudioBuffer }> };
export const PIANO_RELEASE_SECONDS = 0.35;
export const PIANO_LEGATO_RELEASE_SECONDS = 0.5;
export const PIANO_MASTER_GAIN = 0.25;
const KEYS = ['A0', 'C1', 'Ds1', 'Fs1', 'A1', 'C2', 'Ds2', 'Fs2', 'A2', 'C3', 'Ds3', 'Fs3', 'A3', 'C4', 'Ds4', 'Fs4', 'A4', 'C5', 'Ds5', 'Fs5', 'A5', 'C6', 'Ds6', 'Fs6', 'A6', 'C7', 'Ds7', 'Fs7', 'A7', 'C8'] as const;
const banks = new Map<number, Promise<PianoBank>>();

/** AudioBuffers may be shared between live/offline contexts of the same sample rate. */
export function loadPianoBank(context: BaseAudioContext): Promise<PianoBank> {
  const rate = context.sampleRate;
  const cached = banks.get(rate);
  if (cached) return cached;
  const pending = (async () => {
    const samples: PianoBank['samples'] = new Array(KEYS.length);
    let next = 0;
    let failed = false;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (!failed && next < KEYS.length) {
        const index = next++;
        const url = `/audio/piano/${KEYS[index]}.mp3`;
        try {
          const response = await fetch(url, { credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(30_000) });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const bytes = await response.arrayBuffer();
          if (!bytes.byteLength || bytes.byteLength > 4 * 1024 * 1024) throw new Error('采样文件大小无效');
          const buffer = await context.decodeAudioData(bytes);
          if (!buffer.length || !Number.isFinite(buffer.duration) || buffer.duration <= 0 || buffer.numberOfChannels < 1 || buffer.numberOfChannels > 2) throw new Error('无法解码有效钢琴采样');
          samples[index] = { midi: 21 + index * 3, buffer };
        } catch (error) {
          failed = true;
          throw new Error(`本机钢琴采样加载失败（${KEYS[index]}）。请检查采样资源后重新播放。${error instanceof Error ? error.message : ''}`);
        }
      }
    }));
    return { samples };
  })();
  banks.set(rate, pending);
  void pending.catch(() => { if (banks.get(rate) === pending) banks.delete(rate); });
  return pending;
}

/** Preserve the recorded attack/stereo/decay. Offset is source music time, before pitch-rate conversion. */
export function schedulePianoNote(context: BaseAudioContext, destination: AudioNode, bank: PianoBank, midi: number, velocity: number, at: number, duration: number, offsetSeconds = 0, options: { legato?: boolean } = {}): AudioBufferSourceNode | null {
  if (!bank.samples.length) throw new Error('钢琴采样库为空，无法播放。');
  if (![midi, velocity, at, duration, offsetSeconds].every(Number.isFinite) || duration <= 0 || offsetSeconds < 0) throw new Error('钢琴音符时间无效。');
  const end = at + duration;
  const start = Math.max(context.currentTime, at);
  if (start >= end) return null;
  const target = Math.min(127, Math.max(0, midi));
  const sample = bank.samples.reduce((best, item) => Math.abs(item.midi - target) < Math.abs(best.midi - target) ? item : best);
  const source = context.createBufferSource();
  const gain = context.createGain();
  source.buffer = sample.buffer;
  source.loop = false;
  const rate = 2 ** ((target - sample.midi) / 12);
  source.playbackRate.value = rate;
  const offset = Math.min(sample.buffer.duration, (offsetSeconds + Math.max(0, start - at)) * rate);
  const amplitude = Math.pow(Math.min(127, Math.max(0, velocity)) / 127, 1.5);
  // No synthetic fade-in reshapes the recorded hammer attack. Only key release fades.
  gain.gain.setValueAtTime(offset > 0 ? 0 : amplitude, start);
  if (offset > 0) gain.gain.linearRampToValueAtTime(amplitude, start + Math.min(.004, end - start));
  const noteOff = end;
  gain.gain.setValueAtTime(amplitude, noteOff);
  const release = options.legato ? PIANO_LEGATO_RELEASE_SECONDS : PIANO_RELEASE_SECONDS;
  gain.gain.linearRampToValueAtTime(0, noteOff + release);
  source.connect(gain); gain.connect(destination);
  source.onended = () => { source.disconnect(); gain.disconnect(); };
  source.start(start, offset);
  source.stop(noteOff + release);
  return source;
}
