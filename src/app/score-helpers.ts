// 与界面无关的乐谱小工具：音名、声部乐器映射、会话边界、练习摘要等。
// 这里只依赖类型和纯函数，可以在 node 测试中直接调用。
import type { Score, ScoreNote } from '../music/types';
import { isInstrumentId } from '../music/instruments';
import type { InstrumentId } from '../music/instruments';
import { displayPartName } from '../music/part-labels';

const pitchNames = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

/** MIDI 音高转音名，例如 60 → C4、61 → C♯4。 */
export const pitchName = (midi: number) => `${pitchNames[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;

/**
 * 只保留这份谱里存在的声部、且为已知乐器的映射。
 * 鼓组只允许给含打击乐音符的声部。
 */
export function instrumentMap(value: Record<string, string> | undefined, score: Score): Record<string, InstrumentId> {
  const result: Record<string, InstrumentId> = {};
  for (const part of score.parts) {
    const id = value?.[part.id];
    if (isInstrumentId(id) && (id !== 'drums' || part.notes.some(note => note.percussion !== undefined))) {
      result[part.id] = id;
    }
  }
  return result;
}

/** sanitizeSession 需要的乐谱边界。 */
export function scoreBounds(score: Score) {
  return {
    tempo: score.tempo,
    totalBeats: score.totalBeats,
    measureCount: score.measures.length,
    partIds: score.parts.map(part => part.id),
  };
}

/** 当前播放位置所在的小节下标（从 0 开始）；没有乐谱时为 0。 */
export function measureIndexAt(score: Score | null, position: number) {
  return score
    ? Math.max(
        0,
        score.measures.findLastIndex(m => m.startBeat <= position + 0.001),
      )
    : 0;
}

/** 播放器实际静音的声部：只听某声部时，静音其余所有声部。 */
export function effectiveMutedParts(score: Score, solo: string | null, muted: string[]) {
  return solo ? score.parts.filter(p => p.id !== solo).map(p => p.id) : muted;
}

/** 基准速度与 75% / 100% 两个快捷速度，限制在 30–240 BPM。 */
export function tempoPresets(score: Score | null) {
  const baseTempo = score && Number.isFinite(score.tempo) && score.tempo > 0 ? score.tempo : 100;
  return {
    baseTempo,
    slowTempo: Math.max(30, Math.min(240, Math.round(baseTempo * 0.75))),
    fullTempo: Math.max(30, Math.min(240, Math.round(baseTempo))),
  };
}

export type PracticeSummaryInput = {
  score: Score | null;
  solo: string | null;
  muted: string[];
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  transpose: number;
};

/** 播放区“当前练习状态”的一行摘要，以及是否所有声部都被静音。 */
export function practiceSummary({ score, solo, muted, loop, loopStart, loopEnd, transpose }: PracticeSummaryInput) {
  const soloIndex = score?.parts.findIndex(part => part.id === solo) ?? -1;
  const effectiveMutedCount = score?.parts.filter(part => muted.includes(part.id)).length ?? 0;
  const allPartsMuted =
    !!score && soloIndex < 0 && score.parts.length > 0 && effectiveMutedCount === score.parts.length;
  const parts =
    soloIndex >= 0 && score
      ? `只听 ${displayPartName(score.parts[soloIndex].name, soloIndex)}`
      : effectiveMutedCount
        ? `已静音 ${effectiveMutedCount} 部`
        : '全部声部';
  const range = loop ? `循环 ${loopStart} 至 ${loopEnd} 小节` : '整首播放';
  const key = transpose ? `移调 ${transpose > 0 ? '+' : ''}${transpose} 半音` : '原调';
  return { text: `${parts} · ${range} · ${key}`, allPartsMuted };
}

/** 音符下拉框中的标签：音名 · 声部 · 小节内第几拍。 */
export function noteLabel(score: Score | null, note: ScoreNote) {
  const part = score?.parts.find(p => p.id === note.partId);
  const beat = note.beat - (score?.measures[note.measure - 1]?.startBeat || 0) + 1;
  return `${pitchName(note.midi)} · ${part?.name || note.partId} · 第 ${Number(beat.toFixed(2))} 拍`;
}

/** 导出文件名：把文件系统不允许的字符换成下划线。 */
export const exportFileBase = (title: string) => (title || 'score').replace(/[\\/:*?"<>|]/g, '_');
