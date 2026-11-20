import type { Score, ScorePart } from './types';
import { isInstrumentId, type InstrumentId } from './instruments';

export type ArrangementPreset = 'piano-bright' | 'piano-warm' | 'acoustic' | 'strings' | 'electronic';
export const ARRANGEMENTS: readonly { id: ArrangementPreset; label: string }[] = [
  { id: 'piano-bright', label: '明亮钢琴' },
  { id: 'piano-warm', label: '温暖钢琴' },
  { id: 'acoustic', label: '原声组合' },
  { id: 'strings', label: '弦乐组合' },
  { id: 'electronic', label: '电子组合' },
];

function checkedParts(score: Pick<Score, 'parts'>): ScorePart[] {
  if (!score?.parts?.length) throw new Error('乐谱没有声部，无法应用音色组合。');
  const ids = new Set<string>();
  for (const part of score.parts) {
    if (!part.id?.trim() || ids.has(part.id)) throw new Error('声部编号为空或重复，无法应用音色组合。');
    ids.add(part.id);
  }
  return score.parts;
}

/** Only explicit, valid percussion note numbers identify a wholly percussive part. */
function isPercussionPart(part: ScorePart): boolean {
  return (
    part.notes.length > 0 &&
    part.notes.every((note) => Number.isInteger(note.percussion) && note.percussion! >= 0 && note.percussion! <= 127)
  );
}

function isLowPart(part: ScorePart): boolean {
  const pitches = part.notes
    .filter((note) => note.percussion === undefined && Number.isFinite(note.midi) && note.midi >= 0 && note.midi <= 127)
    .map((note) => note.midi)
    .sort((a, b) => a - b);
  if (!pitches.length) return false;
  const middle = Math.floor(pitches.length / 2);
  const median = pitches.length % 2 ? pitches[middle] : (pitches[middle - 1] + pitches[middle]) / 2;
  return median < 55;
}

/** A user-selected preset, not instrument recognition. Names and source metadata are ignored. */
export function getArrangementMap(
  score: Pick<Score, 'parts'>,
  preset: ArrangementPreset,
): Record<string, InstrumentId> {
  if (!ARRANGEMENTS.some((item) => item.id === preset)) throw new Error('未知音色组合，请重新选择。');
  return Object.fromEntries(
    checkedParts(score).map((part) => {
      let instrument: InstrumentId;
      if (isPercussionPart(part)) instrument = 'drums';
      else if (preset === 'piano-bright' || preset === 'piano-warm') instrument = preset;
      else if (preset === 'strings') instrument = 'strings';
      else if (preset === 'acoustic') instrument = isLowPart(part) ? 'bass-electric' : 'guitar-acoustic';
      else instrument = isLowPart(part) ? 'bass-electric' : 'synth-pad';
      return [part.id, instrument];
    }),
  );
}

/** Explicit uniform choice overrides presets; drums cannot silently swallow melodic notes. */
export function allPartsInstrumentMap(
  score: Pick<Score, 'parts'>,
  instrument: InstrumentId,
): Record<string, InstrumentId> {
  if (!isInstrumentId(instrument)) throw new Error('未知音色，请重新选择。');
  const parts = checkedParts(score);
  if (instrument === 'drums' && parts.some((part) => !isPercussionPart(part))) {
    throw new Error('不能将旋律声部统一设为鼓组；鼓组仅适用于已有打击乐编号的声部。');
  }
  return Object.fromEntries(parts.map((part) => [part.id, instrument]));
}
