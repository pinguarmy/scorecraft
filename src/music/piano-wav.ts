import type { Score } from './types';
import { PIANO_MASTER_GAIN } from './piano';
import {
  loadInstrumentBank,
  scheduleInstrumentNote,
  DEFAULT_INSTRUMENT,
  type InstrumentId,
  type InstrumentVoice,
} from './instruments';

const SAMPLE_RATE = 44100;
const CHANNELS = 2;
const MAX_SECONDS = 20 * 60;
const MAX_BYTES = 256 * 1024 * 1024;
type PianoWavOptions = {
  tempo?: number;
  transpose?: number;
  mutedParts?: string[];
  partInstruments?: Record<string, InstrumentId>;
};

/** Shared selected instruments offline. Synthesis occurs only for explicitly selected synthetic presets. */
export async function renderPianoWav(score: Score, options: PianoWavOptions = {}): Promise<Uint8Array> {
  const tempo =
    Number.isFinite(options.tempo) && options.tempo! > 0
      ? options.tempo!
      : Number.isFinite(score.tempo) && score.tempo > 0
        ? score.tempo
        : 120;
  const transpose = Number.isFinite(options.transpose) ? Math.round(options.transpose!) : 0;
  const muted = new Set(options.mutedParts ?? []);
  let beats = Number.isFinite(score.totalBeats) && score.totalBeats > 0 ? score.totalBeats : 0;
  for (const part of score.parts) {
    if (muted.has(part.id)) continue;
    for (const note of part.notes) {
      if (Number.isFinite(note.beat) && Number.isFinite(note.duration) && note.duration > 0)
        beats = Math.max(beats, note.beat + note.duration);
    }
  }
  const seconds = (beats * 60) / tempo + 0.5;
  if (!Number.isFinite(seconds) || seconds > MAX_SECONDS)
    throw new Error('乐谱音频导出时长超过 20 分钟上限，请缩短乐谱或拆分导出。');
  const frames = Math.max(1, Math.ceil(seconds * SAMPLE_RATE));
  // Stereo Float32 render buffer + interleaved PCM16 output, before either is allocated.
  const estimatedBytes = frames * CHANNELS * (Float32Array.BYTES_PER_ELEMENT + Int16Array.BYTES_PER_ELEMENT) + 44;
  if (!Number.isSafeInteger(estimatedBytes) || estimatedBytes > MAX_BYTES)
    throw new Error('钢琴 WAV 导出预计超过 256 MiB 内存限制，请缩短乐谱或选择小节片段。');
  const Constructor =
    globalThis.OfflineAudioContext ||
    (globalThis as typeof globalThis & { webkitOfflineAudioContext?: typeof OfflineAudioContext })
      .webkitOfflineAudioContext;
  if (!Constructor) throw new Error('此环境不支持离线音频解码与渲染，请使用支持 Web Audio 的浏览器导出钢琴 WAV。');
  let context: OfflineAudioContext;
  try {
    context = new Constructor(CHANNELS, frames, SAMPLE_RATE);
  } catch {
    throw new Error('无法分配离线钢琴音频内存，请缩短乐谱或选择小节片段。');
  }
  if (typeof context.decodeAudioData !== 'function') throw new Error('此浏览器缺少音频解码器，无法导出钢琴采样 WAV。');
  const needed = [
    ...new Set(
      score.parts
        .filter((part) => !muted.has(part.id) && part.notes.length)
        .map((part) => options.partInstruments?.[part.id] ?? DEFAULT_INSTRUMENT),
    ),
  ];
  const banks = new Map<InstrumentId, Awaited<ReturnType<typeof loadInstrumentBank>>>();
  // Each loader fetches at most four samples concurrently; load banks sequentially to retain that global bound.
  for (const id of needed) banks.set(id, await loadInstrumentBank(context, id));
  const master = context.createGain();
  master.gain.value = PIANO_MASTER_GAIN;
  master.connect(context.destination);
  const sources: InstrumentVoice[] = [];
  try {
    for (const part of score.parts) {
      if (muted.has(part.id)) continue;
      const id = options.partInstruments?.[part.id] ?? DEFAULT_INSTRUMENT;
      const bank = banks.get(id);
      if (!bank) continue;
      for (const note of part.notes) {
        if (
          !Number.isFinite(note.beat) ||
          !Number.isFinite(note.duration) ||
          !Number.isFinite(note.midi) ||
          note.duration <= 0
        )
          continue;
        const start = Math.max(0, note.beat);
        const end = note.beat + note.duration;
        if (end <= start) continue;
        const voice = scheduleInstrumentNote(
          context,
          master,
          bank,
          {
            midi: Math.max(0, Math.min(127, Math.round(note.midi + (id === 'drums' ? 0 : transpose)))),
            velocity: Number.isFinite(note.velocity) ? note.velocity : 84,
            percussion: note.percussion,
            legato: note.legato,
          },
          (start * 60) / tempo,
          ((end - start) * 60) / tempo,
        );
        if (voice) sources.push(voice);
      }
    }
    const rendered = await context.startRendering();
    return encodeStereoWav(rendered, frames);
  } catch (error) {
    throw new Error(`钢琴 WAV 渲染失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    for (const source of sources) {
      try {
        source.disconnect();
      } catch {
        /* Already disconnected. */
      }
    }
    master.disconnect();
  }
}
function encodeStereoWav(buffer: AudioBuffer, frames: number): Uint8Array {
  if (buffer.numberOfChannels !== CHANNELS || buffer.sampleRate !== SAMPLE_RATE || buffer.length !== frames)
    throw new Error('离线音频输出格式无效，预期双声道 44100 Hz。');
  const left = buffer.getChannelData(0);
  const right = buffer.getChannelData(1);
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    if (!Number.isFinite(left[i]) || !Number.isFinite(right[i])) throw new Error('离线音频包含无效采样值。');
    peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  }
  const scale = peak > 0.98 ? 0.98 / peak : 1;
  const dataBytes = frames * CHANNELS * 2;
  const bytes = new Uint8Array(44 + dataBytes);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * CHANNELS * 2, true);
  view.setUint16(32, CHANNELS * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, dataBytes, true);
  const pcm = (value: number) => Math.round(Math.max(-1, Math.min(1, value * scale)) * (value < 0 ? 32768 : 32767));
  for (let i = 0; i < frames; i++) {
    view.setInt16(44 + i * 4, pcm(left[i]), true);
    view.setInt16(46 + i * 4, pcm(right[i]), true);
  }
  return bytes;
}
