import type { Score } from './types';
import { loadPianoBank, schedulePianoNote, type PianoBank } from './piano';

export type InstrumentId =
  | 'piano-bright'
  | 'piano-warm'
  | 'guitar-acoustic'
  | 'guitar-electric'
  | 'bass-electric'
  | 'strings'
  | 'synth-pad'
  | 'drums';
export const DEFAULT_INSTRUMENT: InstrumentId = 'piano-bright';
export const INSTRUMENTS: readonly {
  id: InstrumentId;
  label: string;
  source: 'sampled' | 'synthetic';
  midiProgram: number;
  percussion?: boolean;
}[] = [
  { id: 'piano-bright', label: '明亮钢琴（录音+均衡）', source: 'sampled', midiProgram: 1 },
  { id: 'piano-warm', label: '温暖钢琴（原录音）', source: 'sampled', midiProgram: 0 },
  { id: 'guitar-acoustic', label: '原声吉他', source: 'sampled', midiProgram: 24 },
  { id: 'guitar-electric', label: '电吉他', source: 'sampled', midiProgram: 27 },
  { id: 'bass-electric', label: '电贝斯', source: 'sampled', midiProgram: 33 },
  { id: 'strings', label: '弦乐·小提琴', source: 'sampled', midiProgram: 40 },
  { id: 'synth-pad', label: '合成铺底', source: 'synthetic', midiProgram: 89 },
  { id: 'drums', label: '电子鼓', source: 'synthetic', midiProgram: 0, percussion: true },
] as const;
export type InstrumentBank = { id: InstrumentId; samples?: PianoBank['samples']; noise?: AudioBuffer };
export type InstrumentVoice = { stop(at?: number): void; disconnect(): void; onended: ((event: Event) => void) | null };
export const SUPPORTED_DRUM_NOTES = [35, 36, 38, 40, 42, 44, 46, 49, 51, 45, 47, 48, 50] as const;
const roots = {
  'guitar-acoustic': ['D2', 'F2', 'Gs2', 'B2', 'D3', 'F3', 'Gs3', 'B3', 'D4', 'F4', 'Gs4', 'B4', 'D5'],
  'guitar-electric': [
    'E2',
    'Fs2',
    'A2',
    'C3',
    'Ds3',
    'Fs3',
    'A3',
    'C4',
    'Ds4',
    'Fs4',
    'A4',
    'C5',
    'Ds5',
    'Fs5',
    'A5',
    'C6',
  ],
  'bass-electric': ['E1', 'G1', 'As1', 'E2', 'As2', 'E3', 'As3', 'E4', 'G4'],
  strings: ['G3', 'C4', 'G4', 'C5', 'G5', 'C6', 'G6', 'C7'],
};
const cache = new Map<string, Promise<InstrumentBank>>();
export function isInstrumentId(value: unknown): value is InstrumentId {
  return INSTRUMENTS.some((instrument) => instrument.id === value);
}
function midiForRoot(root: string): number {
  const match = /^([A-G])(s?)(\d)$/.exec(root)!;
  return (
    (Number(match[3]) + 1) * 12 + ({ C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[match[1]] ?? 0) + (match[2] ? 1 : 0)
  );
}
/** No fetch or AudioContext construction occurs on import. Failures are retryable, never cross-instrument fallbacks. */
export async function loadInstrumentBank(context: BaseAudioContext, id: InstrumentId): Promise<InstrumentBank> {
  if (!isInstrumentId(id)) throw new Error('未知音色，请重新选择。');
  if (id === 'piano-bright' || id === 'piano-warm') return { id, samples: (await loadPianoBank(context)).samples };
  if (id === 'synth-pad') return { id };
  const key = `${context.sampleRate}:${id}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = (async (): Promise<InstrumentBank> => {
    if (id === 'drums') {
      const noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
      const data = noise.getChannelData(0);
      let seed = 23457;
      for (let i = 0; i < data.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        data[i] = seed / 2147483648 - 1;
      }
      return { id, noise };
    }
    const names = roots[id];
    const samples: PianoBank['samples'] = new Array(names.length);
    let next = 0;
    let failed = false;
    await Promise.all(
      Array.from({ length: Math.min(4, names.length) }, async () => {
        while (!failed && next < names.length) {
          const index = next++;
          try {
            const response = await fetch(`/audio/instruments/${id}/${names[index]}.mp3`, {
              credentials: 'same-origin',
              redirect: 'error',
              signal: AbortSignal.timeout(30000),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const bytes = await response.arrayBuffer();
            if (!bytes.byteLength || bytes.byteLength > 4 * 1024 * 1024) throw new Error('采样文件大小无效');
            const buffer = await context.decodeAudioData(bytes);
            if (
              !buffer.length ||
              !Number.isFinite(buffer.duration) ||
              buffer.duration <= 0 ||
              buffer.numberOfChannels < 1 ||
              buffer.numberOfChannels > 2
            )
              throw new Error('采样解码失败');
            samples[index] = { midi: midiForRoot(names[index]), buffer };
          } catch (error) {
            failed = true;
            throw new Error(
              `${INSTRUMENTS.find((item) => item.id === id)!.label}采样加载失败，请重试。${error instanceof Error ? error.message : ''}`,
              { cause: error },
            );
          }
        }
      }),
    );
    return { id, samples };
  })();
  cache.set(key, pending);
  void pending.catch(() => {
    if (cache.get(key) === pending) cache.delete(key);
  });
  return pending;
}
function voiceFor(sources: AudioScheduledSourceNode[], nodes: AudioNode[], cleanup?: () => void): InstrumentVoice {
  let remaining = sources.length;
  let ended = false;
  const voice: InstrumentVoice = {
    onended: null,
    stop(at) {
      for (const source of sources) {
        try {
          source.stop(at);
        } catch {
          /* Already ended. */
        }
      }
    },
    disconnect() {
      for (const node of [...sources, ...nodes]) {
        try {
          node.disconnect();
        } catch {
          /* Already disconnected. */
        }
      }
    },
  };
  for (const source of sources)
    source.onended = (event) => {
      if (--remaining > 0 || ended) return;
      ended = true;
      cleanup?.();
      voice.disconnect();
      voice.onended?.(event);
    };
  return voice;
}
/** Both player and offline export call this function. Drums use explicit GM key numbers, never modulo pitch. */
export function scheduleInstrumentNote(
  context: BaseAudioContext,
  destination: AudioNode,
  bank: InstrumentBank,
  note: { midi: number; velocity: number; percussion?: number; legato?: boolean },
  at: number,
  duration: number,
  offsetSeconds = 0,
): InstrumentVoice | null {
  if (
    ![note.midi, note.velocity, at, duration, offsetSeconds].every(Number.isFinite) ||
    duration <= 0 ||
    offsetSeconds < 0
  )
    throw new Error('音符时间或音高无效。');
  const end = at + duration;
  const start = Math.max(context.currentTime, at);
  if (start >= end) return null;
  if (bank.samples) {
    const filter = bank.id === 'piano-bright' ? context.createBiquadFilter() : undefined;
    if (filter) {
      filter.type = 'highshelf';
      filter.frequency.value = 2000;
      filter.gain.value = 3;
      filter.connect(destination);
    }
    const source = schedulePianoNote(
      context,
      filter || destination,
      { samples: bank.samples },
      note.midi,
      note.velocity,
      at,
      duration,
      offsetSeconds,
      { legato: (bank.id === 'piano-bright' || bank.id === 'piano-warm') && note.legato === true },
    );
    if (!source) {
      filter?.disconnect();
      return null;
    }
    const original = source.onended;
    return voiceFor([source], filter ? [filter] : [], () => original?.call(source, new Event('ended')));
  }
  const gain = context.createGain();
  gain.connect(destination);
  const volume = Math.pow(Math.min(127, Math.max(0, note.velocity)) / 127, 1.5);
  if (bank.id === 'synth-pad') {
    const a = context.createOscillator();
    const b = context.createOscillator();
    a.type = 'sine';
    b.type = 'triangle';
    const frequency = 440 * 2 ** ((note.midi - 69) / 12);
    a.frequency.value = frequency;
    b.frequency.value = frequency * 1.003;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume * 0.22, start + Math.min(0.06, (end - start) / 2));
    gain.gain.setValueAtTime(volume * 0.22, end);
    gain.gain.linearRampToValueAtTime(0, end + 0.35);
    a.connect(gain);
    b.connect(gain);
    const voice = voiceFor([a, b], [gain]);
    a.start(start);
    b.start(start);
    a.stop(end + 0.35);
    b.stop(end + 0.35);
    return voice;
  }
  if (bank.id !== 'drums' || !bank.noise) {
    gain.disconnect();
    throw new Error('音色采样库无效，不能替换为其他声音。');
  }
  const key = note.percussion;
  if (key === undefined || !(SUPPORTED_DRUM_NOTES as readonly number[]).includes(key)) {
    gain.disconnect();
    return null;
  }
  const kick = key === 35 || key === 36;
  const tom = [45, 47, 48, 50].includes(key);
  const snare = key === 38 || key === 40;
  const length = kick ? 0.3 : tom ? 0.28 : snare ? 0.18 : key === 46 ? 0.35 : key === 49 || key === 51 ? 0.45 : 0.08;
  gain.gain.setValueAtTime(volume * (kick || tom ? 0.8 : 0.45), start);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  if (kick || tom) {
    const oscillator = context.createOscillator();
    oscillator.type = 'sine';
    const base = kick ? 55 : { 45: 110, 47: 145, 48: 165, 50: 195 }[key] || 120;
    oscillator.frequency.setValueAtTime(base * (kick ? 2.8 : 1.35), start);
    oscillator.frequency.exponentialRampToValueAtTime(base, start + 0.07);
    oscillator.connect(gain);
    const voice = voiceFor([oscillator], [gain]);
    oscillator.start(start);
    oscillator.stop(start + length);
    return voice;
  }
  const noise = context.createBufferSource();
  noise.buffer = bank.noise;
  noise.loop = false;
  const filter = context.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = snare ? 1100 : 6500;
  noise.connect(filter);
  filter.connect(gain);
  const voice = voiceFor([noise], [filter, gain]);
  noise.start(start);
  noise.stop(start + length);
  return voice;
}
export function getInstrumentWarnings(score: Score, partInstruments: Record<string, InstrumentId> = {}): string[] {
  const warnings: string[] = [];
  for (const part of score.parts) {
    if (partInstruments[part.id] !== 'drums') continue;
    const skipped = part.notes.filter(
      (note) => note.percussion === undefined || !(SUPPORTED_DRUM_NOTES as readonly number[]).includes(note.percussion),
    ).length;
    if (skipped)
      warnings.push(
        `${part.name}有 ${skipped} 个音符缺少支持的 GM 打击乐编号，已跳过；鼓组用于已识别的打击乐声部，不会自动把旋律编成鼓点。`,
      );
  }
  return warnings;
}
