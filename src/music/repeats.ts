import type { ScoreMeasure, ScorePlayback } from './types';

const children = (element: Element, tag?: string): Element[] =>
  Array.from(element.childNodes).filter((node) => node.nodeType === 1 && (!tag || node.nodeName === tag)) as Element[];
const all = (element: Element, tag: string): Element[] => Array.from(element.getElementsByTagName(tag));
type Marker = { measure: number; direction: 'forward' | 'backward'; times: number };

/** Deliberately supports only unambiguous, non-nested ordinary barline repeats. */
export function buildRepeatPlayback(
  root: Element,
  measures: ScoreMeasure[],
  totalBeats: number,
): { playback: ScorePlayback; warnings: string[] } {
  const straight: ScorePlayback = {
    segments: [{ sourceStart: 0, sourceEnd: totalBeats, playStart: 0 }],
    totalBeats,
    expanded: false,
  };
  const fallback = (reason: string) => ({
    playback: straight,
    warnings: [`${reason}，已按源谱顺序直奏，未展开反复。`],
  });
  if (all(root, 'ending').length) return fallback('暂不支持一房二房等 ending 结构');
  const jumpAttributes = ['dacapo', 'dalsegno', 'segno', 'coda', 'tocoda', 'fine'];
  const jumpWords = /\bD\.?\s*[CS]\.?\b|da\s+capo|dal\s+segno|\bsegno\b|\bcoda\b/i;
  if (
    all(root, 'segno').length ||
    all(root, 'coda').length ||
    all(root, 'sound').some((sound) => jumpAttributes.some((attr) => sound.hasAttribute(attr))) ||
    all(root, 'words').some((words) => jumpWords.test(words.textContent || ''))
  )
    return fallback('暂不支持 D.C.、D.S.、segno 或 coda 跳转');
  const parts = children(root, 'part');
  const topologies: Marker[][] = [];
  for (const part of parts) {
    const markers: Marker[] = [];
    const partMeasures = children(part, 'measure');
    let counted = 0;
    for (let index = 0; index < partMeasures.length; index++) {
      const seen = new Set<string>();
      for (const barline of children(partMeasures[index], 'barline')) {
        for (const repeat of children(barline, 'repeat')) {
          counted++;
          const direction = repeat.getAttribute('direction');
          const location = barline.getAttribute('location') || 'right';
          if (direction !== 'forward' && direction !== 'backward') return fallback('反复记号 direction 无效');
          if ((direction === 'forward' && location !== 'left') || (direction === 'backward' && location !== 'right'))
            return fallback('暂不支持该反复线位置，仅支持小节左侧起点和右侧终点');
          if (seen.has(direction)) return fallback('同一小节有重复或歧义的反复记号');
          seen.add(direction);
          const rawTimes = repeat.getAttribute('times');
          const times = rawTimes ? Number(rawTimes) : 2;
          if (!Number.isInteger(times) || times < 2 || times > 8) return fallback('反复次数必须为 2 到 8 的整数');
          markers.push({ measure: index, direction, times: direction === 'backward' ? times : 2 });
        }
      }
    }
    if (counted !== all(part, 'repeat').length) return fallback('反复记号不在有效的小节线内');
    if (markers.length && partMeasures.length !== measures.length)
      return fallback('声部小节数量不一致，反复范围不明确');
    // MusicXML child order can put the right barline before the left one.
    markers.sort(
      (a, b) => a.measure - b.measure || (a.direction === b.direction ? 0 : a.direction === 'forward' ? -1 : 1),
    );
    topologies.push(markers);
  }
  if (!topologies.some((markers) => markers.length)) return { playback: straight, warnings: [] };
  if (topologies.some((markers) => JSON.stringify(markers) !== JSON.stringify(topologies[0])))
    return fallback('各声部的反复记号不一致');
  const regions: { start: number; end: number; times: number }[] = [];
  let open: number | undefined;
  let priorEnd = -1;
  for (const marker of topologies[0]) {
    if (marker.direction === 'forward') {
      if (open !== undefined) return fallback('暂不支持嵌套或重叠的反复');
      open = marker.measure;
    } else {
      if (open === undefined && priorEnd >= 0) return fallback('后续反复缺少明确起点，范围有歧义');
      const start = open ?? 0;
      if (start <= priorEnd || start > marker.measure) return fallback('反复范围重叠或顺序无效');
      regions.push({ start, end: marker.measure, times: marker.times });
      priorEnd = marker.measure;
      open = undefined;
    }
  }
  if (open !== undefined) return fallback('反复起点没有配对的终点');
  let sourceEnd = 0;
  for (const measure of measures) {
    if (
      !Number.isFinite(measure.startBeat) ||
      !Number.isFinite(measure.duration) ||
      measure.duration <= 0 ||
      Math.abs(measure.startBeat - sourceEnd) > 1e-6
    )
      return fallback('源谱小节时间线不连续或时长无效');
    sourceEnd = measure.startBeat + measure.duration;
  }
  if (!Number.isFinite(totalBeats) || sourceEnd > totalBeats + 1e-6) return fallback('源谱总时长与小节范围不一致');
  const segments: ScorePlayback['segments'] = [];
  let playStart = 0;
  const append = (index: number) => {
    const measure = measures[index];
    segments.push({ sourceStart: measure.startBeat, sourceEnd: measure.startBeat + measure.duration, playStart });
    playStart += measure.duration;
    return segments.length <= 10000;
  };
  const starts = new Map(regions.map((region) => [region.start, region]));
  for (let index = 0; index < measures.length;) {
    const region = starts.get(index);
    if (region) {
      for (let pass = 0; pass < region.times; pass++) {
        for (let measure = region.start; measure <= region.end; measure++)
          if (!append(measure)) return fallback('反复展开超过 10000 个片段的安全上限');
      }
      index = region.end + 1;
    } else {
      if (!append(index)) return fallback('反复展开超过 10000 个片段的安全上限');
      index++;
    }
  }
  if (sourceEnd < totalBeats) {
    if (segments.length >= 10000) return fallback('反复展开超过 10000 个片段的安全上限');
    segments.push({ sourceStart: sourceEnd, sourceEnd: totalBeats, playStart });
    playStart += totalBeats - sourceEnd;
  }
  return { playback: { segments, totalBeats: playStart, expanded: true }, warnings: [] };
}
