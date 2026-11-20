import type { MusicSheet, OpenSheetMusicDisplay } from 'opensheetmusicdisplay';
import type { MultiExpression } from 'opensheetmusicdisplay/build/dist/src/MusicalScore/VoiceData/Expressions/MultiExpression';

export type CanonicalMeasure = { number: number; startBeat: number; duration: number };

/** Source playback and engraving can disagree about malformed/overfull bar lengths.
 * Match the measure identity first, then preserve the in-measure quarter-note offset.
 */
export function sourceToEngravingBeat(
  sheet: MusicSheet,
  sourceBeat: number,
  measures?: readonly CanonicalMeasure[],
): number {
  const beat = Math.max(0, Number.isFinite(sourceBeat) ? sourceBeat : 0);
  if (!measures?.length) return beat;
  const index = Math.max(
    0,
    measures.findLastIndex((measure) => measure.startBeat <= beat + 1e-7),
  );
  const engraved = sheet.SourceMeasures[index];
  if (!engraved) return beat;
  const offset = Math.max(0, beat - measures[index].startBeat);
  // Keep an overfull source bar on that same engraved bar until its actual end.
  const duration = engraved.Duration.RealValue * 4;
  return engraved.AbsoluteTimestamp.RealValue * 4 + Math.min(offset, Math.max(0, duration - 1e-7));
}

export function engravingToSourceBeat(
  sheet: MusicSheet,
  measureIndex: number,
  engravingBeat: number,
  measures?: readonly CanonicalMeasure[],
): number {
  const source = measures?.[measureIndex];
  const engraved = sheet.SourceMeasures[measureIndex];
  if (!source || !engraved) return engravingBeat;
  return (
    source.startBeat + Math.min(source.duration, Math.max(0, engravingBeat - engraved.AbsoluteTimestamp.RealValue * 4))
  );
}

/** OSMD positions its HTML cursor in native SVG pixels, but responsive CSS may
 * scale only the SVG. Use the SVG's screen transform, not accumulated native y.
 * Call directly after cursor.update(), which restores the native geometry.
 */
export function alignCursorToSvg(osmd: OpenSheetMusicDisplay): void {
  const image = osmd.cursor?.cursorElement;
  const parent = image?.parentElement;
  const svg = parent?.querySelector('svg');
  const ctm = svg?.getScreenCTM();
  const offsetParent = image?.offsetParent as HTMLElement | null;
  if (!image || !svg || !ctm || !offsetParent) return;
  const x = Number.parseFloat(image.style.left);
  const y = Number.parseFloat(image.style.top);
  if (![x, y, ctm.a, ctm.d].every(Number.isFinite)) return;
  const anchor = new DOMPoint(x, y).matrixTransform(ctm);
  const origin = offsetParent.getBoundingClientRect();
  image.style.left = `${anchor.x - origin.left - offsetParent.clientLeft + offsetParent.scrollLeft}px`;
  image.style.top = `${anchor.y - origin.top - offsetParent.clientTop + offsetParent.scrollTop}px`;
  image.style.width = `${Number(image.getAttribute('width')) * Math.abs(ctm.a)}px`;
  image.style.height = `${Number(image.getAttribute('height')) * Math.abs(ctm.d)}px`;
}

/** OSMD 1.9.9's CursorIgnoreRepetitions only suppresses backwards jumps.
 * Incomplete/alternate endings can still jump forwards over source measures.
 * Playback owns all repeat semantics, so hide traversal instructions only during
 * this synchronous cursor operation, then restore the original display model.
 */
function inSourceOrder<T>(sheet: MusicSheet, visit: () => T): T {
  const saved: Array<{
    instructions: MusicSheet['SourceMeasures'][number]['FirstRepetitionInstructions'];
    entries: MusicSheet['SourceMeasures'][number]['FirstRepetitionInstructions'];
  }> = [];
  for (const measure of sheet.SourceMeasures) {
    for (const instructions of [measure.FirstRepetitionInstructions, measure.LastRepetitionInstructions]) {
      if (instructions.length) saved.push({ instructions, entries: instructions.splice(0) });
    }
  }
  try {
    return visit();
  } finally {
    for (const { instructions, entries } of saved) instructions.push(...entries);
  }
}

/** Move the actual iterator: OSMD clone() aliases voice-entry arrays in 1.9.9. */
export function syncSourceCursor(
  osmd: OpenSheetMusicDisplay,
  sourceBeat: number,
  measures?: readonly CanonicalMeasure[],
) {
  return inSourceOrder(osmd.Sheet, () => {
    const cursor = osmd.cursor;
    const target = sourceToEngravingBeat(osmd.Sheet, sourceBeat, measures) / 4;
    if (cursor.hidden) cursor.show();
    if (cursor.iterator.CurrentSourceTimestamp.RealValue > target + 1e-7) cursor.resetIterator();
    const iterator = cursor.iterator;
    let steps = 0;
    while (!iterator.EndReached && iterator.CurrentSourceTimestamp.RealValue < target - 1e-7 && steps++ < 100000) {
      const beforeTime = iterator.CurrentSourceTimestamp.RealValue;
      const beforeMeasure = iterator.CurrentMeasureIndex;
      iterator.moveToNextVisibleVoiceEntry(false);
      if (iterator.EndReached || iterator.CurrentSourceTimestamp.RealValue > target + 1e-7) {
        iterator.moveToPreviousVisibleVoiceEntry(false);
        break;
      }
      if (iterator.CurrentSourceTimestamp.RealValue === beforeTime && iterator.CurrentMeasureIndex === beforeMeasure)
        break;
    }
    cursor.update();
    alignCursorToSvg(osmd);
    const measureIndex = iterator.CurrentMeasureIndex;
    const engravingBeat = iterator.CurrentSourceTimestamp.RealValue * 4;
    return {
      sourceBeat: engravingToSourceBeat(osmd.Sheet, measureIndex, engravingBeat, measures),
      engravingBeat,
      measure: measureIndex + 1,
    };
  });
}

export type RenderCompatibilityResult = { repairedOctaveShifts: number; warnings: string[] };

/** Repair only the disposable OSMD display model, never the source XML or Score.
 * OSMD 1.9.9 already treats an open ottava as continuing to the last measure,
 * but its layout fallback calls Fraction.lte(undefined) when no end expression
 * exists. Supply that same end-of-score boundary explicitly, retaining every
 * note, staff, expression start, pitch and duration. The user must verify OMR.
 */
export function repairOpenOctaveShifts(sheet: MusicSheet): RenderCompatibilityResult {
  const measures = sheet.SourceMeasures;
  const last = measures[measures.length - 1];
  if (!last) return { repairedOctaveShifts: 0, warnings: [] };
  let repairedOctaveShifts = 0;
  for (const measure of measures) {
    measure.StaffLinkedExpressions.forEach((expressions, staffIndex) => {
      for (const expression of expressions) {
        const shift = expression.OctaveShiftStart;
        if (!shift || shift.ParentEndMultiExpression) continue;
        // MultiExpression is declared but not exported by OSMD's UMD runtime.
        // Reuse the actual loaded expression class, without patching prototypes.
        const Expression = expression.constructor as new (
          measure: typeof last,
          timestamp: typeof last.Duration,
        ) => MultiExpression;
        const end = new Expression(last, last.Duration.clone());
        end.StaffNumber = staffIndex + 1;
        shift.ParentEndMultiExpression = end;
        repairedOctaveShifts++;
      }
    });
  }
  return {
    repairedOctaveShifts,
    warnings: repairedOctaveShifts
      ? [
          `识别结果有 ${repairedOctaveShifts} 处八度移位线缺少结束标记。仅为排版将线延伸至谱尾，未修改原始乐谱、音符或播放音高，也不能确认缺失标记的原意，请对照原稿核对。`,
        ]
      : [],
  };
}
