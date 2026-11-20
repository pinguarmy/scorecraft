import type { Score } from './types';

/** Performance-only copy. XML deliberately remains the complete source notation. */
export function excerptScore(score: Score, range: { start: number; end: number }): Score {
  const { start, end } = range ?? {};
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > score.measures.length) {
    throw new Error('导出小节范围无效，请选择乐谱内起止小节，起止值须为整数且起点不大于终点。');
  }
  const selected = score.measures.slice(start - 1, end);
  const from = selected[0].startBeat;
  const to = selected.at(-1)!.startBeat + selected.at(-1)!.duration;
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    to <= from ||
    selected.some(
      (measure, index) =>
        !Number.isFinite(measure.duration) ||
        measure.duration <= 0 ||
        (index > 0 &&
          Math.abs(measure.startBeat - selected[index - 1].startBeat - selected[index - 1].duration) > 1e-6),
    )
  ) {
    throw new Error('所选小节时间线无效或不连续，无法安全导出片段。');
  }
  const measures = selected.map((measure, index) => ({
    ...measure,
    number: index + 1,
    startBeat: measure.startBeat - from,
  }));
  const parts = score.parts.map((part) => ({
    ...part,
    notes: part.notes.flatMap((note) => {
      const clippedStart = Math.max(from, note.beat);
      const clippedEnd = Math.min(to, note.beat + note.duration);
      if (!(clippedEnd > clippedStart) || !Number.isFinite(clippedStart) || !Number.isFinite(clippedEnd)) return [];
      const beat = clippedStart - from;
      const measure = measures.find((item) => beat >= item.startBeat && beat < item.startBeat + item.duration);
      return [{ ...note, beat, duration: clippedEnd - clippedStart, measure: measure?.number ?? 1 }];
    }),
  }));
  return { ...score, parts, measures, totalBeats: to - from, playback: undefined, warnings: [...score.warnings] };
}
