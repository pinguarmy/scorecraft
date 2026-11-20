import type { Score, PlaybackSegment, ScoreMeasure, ScoreNote } from './types';

/** Coalesce adjacent source measures so sustained notes only split at an actual jump. */
export function playbackSegments(score: Score): PlaybackSegment[] {
  if (!score.playback?.expanded) return [{ sourceStart: 0, sourceEnd: score.totalBeats, playStart: 0 }];
  const runs: PlaybackSegment[] = [];
  for (const segment of score.playback.segments) {
    const prior = runs.at(-1);
    if (
      prior &&
      Math.abs(prior.sourceEnd - segment.sourceStart) < 1e-7 &&
      Math.abs(prior.playStart + prior.sourceEnd - prior.sourceStart - segment.playStart) < 1e-7
    )
      prior.sourceEnd = segment.sourceEnd;
    else runs.push({ ...segment });
  }
  return runs;
}
export function playbackToSource(score: Score, beat: number): number {
  if (!score.playback?.expanded) return Math.max(0, Math.min(score.totalBeats, beat));
  if (beat >= score.playback.totalBeats) return score.totalBeats;
  const segment = score.playback.segments.find(
    (s) => beat >= s.playStart && beat < s.playStart + s.sourceEnd - s.sourceStart,
  );
  return segment ? segment.sourceStart + beat - segment.playStart : 0;
}
export function sourceToPlayback(score: Score, beat: number): number {
  if (!score.playback?.expanded || beat >= score.totalBeats)
    return beat >= score.totalBeats ? (score.playback?.totalBeats ?? score.totalBeats) : Math.max(0, beat);
  const segment = score.playback.segments.find((s) => beat >= s.sourceStart && beat < s.sourceEnd);
  return segment ? segment.playStart + beat - segment.sourceStart : 0;
}
/** A new performance copy. Source notes, IDs, measures and XML remain untouched. */
export function getPlaybackScore(score: Score): Score {
  if (!score.playback?.expanded) return score;
  const segments = playbackSegments(score);
  const measures: ScoreMeasure[] = [];
  for (const segment of segments) {
    for (const measure of score.measures) {
      const start = Math.max(segment.sourceStart, measure.startBeat);
      const end = Math.min(segment.sourceEnd, measure.startBeat + measure.duration);
      if (end > start)
        measures.push({
          number: measures.length + 1,
          startBeat: segment.playStart + start - segment.sourceStart,
          duration: end - start,
        });
    }
  }
  const parts = score.parts.map((part) => {
    const notes: ScoreNote[] = [];
    segments.forEach((segment, pass) => {
      for (const note of part.notes) {
        const start = Math.max(segment.sourceStart, note.beat);
        const end = Math.min(segment.sourceEnd, note.beat + note.duration);
        if (end <= start) continue;
        const beat = segment.playStart + start - segment.sourceStart;
        const measure = measures.find((m) => beat >= m.startBeat && beat < m.startBeat + m.duration);
        notes.push({
          ...note,
          id: `${note.id}@play${pass}`,
          beat,
          duration: end - start,
          measure: measure?.number ?? 1,
        });
      }
    });
    return { ...part, notes };
  });
  return { ...score, parts, measures, totalBeats: score.playback.totalBeats, playback: undefined };
}
