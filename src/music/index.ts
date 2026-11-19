import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { unzipSync } from 'fflate';
import type { Score, ScoreNote, ScoreMeasure } from './types';
import { buildRepeatPlayback } from './repeats';
import { displayPartName } from './part-labels';
import { scoreDetailWarnings } from './capabilities';
export { displayPartName, translatePartName, updatePartNameXml } from './part-labels';
export { PLAYBACK_CAPABILITY_SUMMARY } from './capabilities';
export { INSTRUMENTS, DEFAULT_INSTRUMENT, isInstrumentId, loadInstrumentBank, scheduleInstrumentNote, getInstrumentWarnings } from './instruments';
export type { InstrumentId, InstrumentBank, InstrumentVoice } from './instruments';
export { inspectOpenOctaveShifts, removeOpenOctaveShiftsXml, updateTimeSignatureXml } from './score-details';
export type { Score, ScoreNote, ScorePart, ScoreMeasure, ScorePlayback, PlaybackSegment } from './types';
export { getPlaybackScore } from './playback';
export { excerptScore } from './excerpt';
export { exportMidi, scoreToWav } from './export';
export type { ExportOptions } from './export';
export { ScorePlayer } from './player';

type XmlDocument = Document;
type XmlElement = Element;
const MAX_XML = 20 * 1024 * 1024;
const serialize = (doc: XmlDocument) => new XMLSerializer().serializeToString(doc);
const all = (el: XmlElement, name: string): XmlElement[] => Array.from(el.getElementsByTagName(name));
const children = (el: XmlElement, name?: string): XmlElement[] => Array.from(el.childNodes).filter(n => n.nodeType === 1 && (!name || n.nodeName === name)) as XmlElement[];
const first = (el: XmlElement, name: string) => children(el, name)[0];
const text = (el: XmlElement | undefined, fallback = '') => el?.textContent?.trim() || fallback;
const value = (el: XmlElement, name: string, fallback = 0) => {
  const n = Number(text(first(el, name), String(fallback)));
  return Number.isFinite(n) ? n : fallback;
};
function parseXml(xml: string): XmlDocument {
  if (!xml.trim() || xml.length > MAX_XML) throw new Error('乐谱为空或超过 20 MB 限制。');
  // MusicXML's ordinary public DOCTYPE is safe; external entity declarations are not.
  if (/<!ENTITY\s/i.test(xml) || /<!DOCTYPE[^>]*\[/i.test(xml)) throw new Error('不支持带自定义实体的 XML。');
  const clean = xml.replace(/<!DOCTYPE[^>]*>/gi, '');
  let problem = '';
  const doc = new DOMParser({ errorHandler: (_level, message) => { problem = String(message); } }).parseFromString(clean, 'application/xml');
  if (problem || !doc.documentElement || doc.documentElement.tagName === 'parsererror') throw new Error('MusicXML 格式无效，请检查文件是否完整。');
  return doc;
}
function decoded(bytes: Uint8Array): string {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  return new TextDecoder(encoding).decode(bytes);
}
function inputXml(input: string | ArrayBuffer | Uint8Array): string {
  if (typeof input === 'string') return input;
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength > MAX_XML) throw new Error('文件超过 20 MB 限制。');
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return decoded(bytes);
  let expanded = 0;
  const files = unzipSync(bytes, { filter: entry => {
    expanded += entry.originalSize;
    if (expanded > MAX_XML) throw new Error('MXL 解压后超过 20 MB 限制。');
    return !entry.name.endsWith('/');
  } });
  const container = files['META-INF/container.xml'];
  let path = '';
  if (container) {
    const doc = parseXml(decoded(container));
    path = all(doc.documentElement!, 'rootfile')[0]?.getAttribute('full-path') || '';
  }
  if (!path) path = Object.keys(files).find(name => /\.(musicxml|xml)$/i.test(name) && !name.startsWith('META-INF/')) || '';
  if (!path || !files[path]) throw new Error('MXL 内没有找到 MusicXML 乐谱。');
  return decoded(files[path]);
}
const pitchClasses: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function pitchMidi(pitch: XmlElement): number {
  const step = text(first(pitch, 'step'));
  if (!(step in pitchClasses)) throw new Error('乐谱包含无效音高。');
  return (value(pitch, 'octave', 4) + 1) * 12 + pitchClasses[step] + value(pitch, 'alter');
}
export async function readScore(input: string | ArrayBuffer | Uint8Array, _filename?: string): Promise<Score> {
  const doc = parseXml(inputXml(input));
  const root = doc.documentElement!;
  if (root.tagName !== 'score-partwise') throw new Error('仅支持 score-partwise MusicXML，请先转换此乐谱。');
  const warnings = new Set<string>();
  const warn = (message: string) => warnings.add(message);
  const partList = first(root, 'part-list');
  const definitions = partList ? children(partList, 'score-part') : [];
  const measures: ScoreMeasure[] = [];
  const durations = children(root, 'part').map(part => {
    let divisions = 1;
    let meter = 4;
    return children(part, 'measure').map(measure => {
      let cursor = 0;
      let extent = 0;
      let previous = 0;
      for (const element of children(measure)) {
        if (element.tagName === 'attributes') {
          divisions = Math.max(1, value(element, 'divisions', divisions));
          const time = first(element, 'time');
          if (time) {
            const numerator = text(first(time, 'beats'), '4').split('+').reduce((sum, beat) => sum + (Number(beat) || 0), 0);
            const next = numerator * 4 / value(time, 'beat-type', 4);
            if (next > 0 && Number.isFinite(next)) meter = next;
          }
        } else if (element.tagName === 'backup') cursor = Math.max(0, cursor - value(element, 'duration') / divisions);
        else if (element.tagName === 'forward') { cursor += value(element, 'duration') / divisions; extent = Math.max(extent, cursor); }
        else if (element.tagName === 'note' && !first(element, 'grace')) {
          const duration = Math.max(0, value(element, 'duration') / divisions);
          const chord = !!first(element, 'chord');
          const start = chord ? previous : cursor;
          if (!chord) { previous = start; cursor += duration; }
          extent = Math.max(extent, cursor, start + duration);
        }
      }
      if (extent > meter + .001) warn('部分小节的音符时值超过拍号，已保留全部音符并按最长声部对齐，请对照原稿核对节奏。');
      return measure.getAttribute('implicit') === 'yes' && extent > 0 ? extent : Math.max(meter, extent);
    });
  });
  const measureCount = durations.reduce((count, part) => Math.max(count, part.length), 0);
  let canonicalStart = 0;
  for (let index = 0; index < measureCount; index++) {
    const lengths = durations.map(part => part[index]).filter((length): length is number => length !== undefined);
    const duration = lengths.reduce((longest, length) => Math.max(longest, length), 0);
    if (lengths.length !== durations.length || lengths.some(length => Math.abs(length - duration) > .001)) warn('识别小节时值不齐，已按各小节最长声部对齐，可能拉长原小节，请对照原稿核对。');
    measures.push({ number: index + 1, startBeat: canonicalStart, duration });
    canonicalStart += duration;
  }
  let tempo = 100;
  let tempoSeen = false;
  let initialBeats = 4;
  let initialTimeSeen = false;
  const parts = children(root, 'part').flatMap((partEl, partIndex) => {
    const id = partEl.getAttribute('id') || `P${partIndex + 1}`;
    const def = definitions.find(el => el.getAttribute('id') === id);
    const instrumentEl = def && all(def, 'midi-program')[0];
    const program = instrumentEl ? Math.max(0, Math.min(127, Number(text(instrumentEl)) - 1 || 0)) : 0;
    const percussionDefinitions = def ? children(def, 'midi-instrument').filter(element => !!first(element, 'midi-unpitched')) : [];
    const percussionFor = (note: XmlElement): number | undefined => {
      const instrumentId = first(note, 'instrument')?.getAttribute('id');
      const matches = percussionDefinitions.filter(element => instrumentId ? element.getAttribute('id') === instrumentId : percussionDefinitions.length === 1);
      if (matches.length !== 1) return undefined;
      const value = Number(text(first(matches[0], 'midi-unpitched'))) - 1;
      return Number.isInteger(value) && value >= 0 && value <= 127 ? value : undefined;
    };
    const notes: ScoreNote[] = [];
    const staffCount = Math.max(1, ...all(partEl, 'staves').map(el => Number(text(el)) || 1));
    const openTies = new Map<string, ScoreNote>();
    const phraseNotes = new Map<string, { stream: string; staccato: boolean }>();
    const slurEvents: { scope: string; stream: string; beat: number; type: string }[] = [];
    let divisions = 1;
    let beatsPerMeasure = 4;
    let velocity = 84;
    children(partEl, 'measure').forEach((measureEl, measureIndex) => {
      const measureStart = measures[measureIndex].startBeat;
      let cursor = 0;
      let extent = 0;
      let previousNoteStart = 0;
      let noteIndex = 0;
      for (const el of children(measureEl)) {
        if (el.tagName === 'attributes') {
          divisions = Math.max(1, value(el, 'divisions', divisions));
          const time = first(el, 'time');
          if (time) {
            const beatText = text(first(time, 'beats'), '4');
            const numerator = beatText.split('+').reduce((sum, beat) => sum + (Number(beat) || 0), 0);
            const denominator = value(time, 'beat-type', 4);
            const next = numerator * 4 / denominator;
            if (next > 0 && Number.isFinite(next)) {
              beatsPerMeasure = next;
              if (!initialTimeSeen) { initialBeats = next; initialTimeSeen = true; }
              else if (next !== initialBeats) warn('乐谱包含拍号变化；小节范围已保留，节拍器按四分音符计拍。');
            }
          }
          if (first(el, 'transpose')) warn('移调乐器目前按谱面音高播放，未应用乐器移调。');
        } else if (el.tagName === 'backup') cursor = Math.max(0, cursor - value(el, 'duration') / divisions);
        else if (el.tagName === 'forward') { cursor += value(el, 'duration') / divisions; extent = Math.max(extent, cursor); }
        else if (el.tagName === 'direction') {
          const sound = all(el, 'sound')[0];
          const bpmText = sound?.getAttribute('tempo');
          const metro = all(el, 'metronome')[0];
          let bpm = bpmText ? Number(bpmText) : metro ? value(metro, 'per-minute', 0) : 0;
          if (!bpmText && metro) {
            const units: Record<string, number> = { whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25 };
            bpm *= units[text(first(metro, 'beat-unit'))] || 1;
            if (first(metro, 'beat-unit-dot')) bpm *= 1.5;
          }
          if (bpm > 0 && Number.isFinite(bpm)) {
            if (!tempoSeen) { tempo = Math.min(400, Math.max(20, bpm)); tempoSeen = true; }
            else if (Math.abs(bpm - tempo) > .01) warn('速度变化尚未播放；全曲使用第一个速度标记。');
          }
          const dynamicSound = all(el, 'sound').find(element => element.hasAttribute('dynamics') && element.getAttribute('dynamics')!.trim() !== '' && Number.isFinite(Number(element.getAttribute('dynamics'))) && Number(element.getAttribute('dynamics')) >= 0);
          const dynamics: Record<string, number> = { ppp: 24, pp: 36, p: 48, mp: 60, mf: 76, f: 92, ff: 108, fff: 120 };
          const symbol = all(el, 'dynamics').flatMap(element => children(element)).find(element => element.tagName in dynamics);
          if (dynamicSound) velocity = Math.max(0, Math.min(127, Math.round(Number(dynamicSound.getAttribute('dynamics')) * .9)));
          else if (symbol) velocity = dynamics[symbol.tagName];
          if (all(el, 'wedge').length) warn('渐强和渐弱暂未应用到播放。');
        } else if (el.tagName === 'note') {
          const noteId = `p${partIndex}-m${measureIndex}-n${noteIndex++}`;
          el.setAttribute('id', noteId);
          if (first(el, 'grace')) { warn('装饰音暂未播放。'); continue; }
          const chord = !!first(el, 'chord');
          const duration = Math.max(0, value(el, 'duration') / divisions);
          const start = chord ? previousNoteStart : cursor;
          if (!chord) { previousNoteStart = start; cursor += duration; }
          extent = Math.max(extent, start + duration, cursor);
          if (first(el, 'cue')) { warn('提示音符暂未播放。'); continue; }
          const pitch = first(el, 'pitch');
          const unpitched = first(el, 'unpitched');
          const percussion = unpitched ? percussionFor(el) : undefined;
          if (first(el, 'rest') || duration <= 0) continue;
          if (!pitch && percussion === undefined) { if (unpitched) warn('部分无固定音高音符缺少明确 midi-unpitched 鼓号，未猜测鼓件，相关音符未播放。'); continue; }
          const midi = percussion ?? pitchMidi(pitch!);
          if (midi % 1) warn('微分音播放已近似到最近的半音。');
          const ties = [...children(el, 'tie'), ...all(el, 'tied')];
          const tieStart = ties.some(t => t.getAttribute('type') === 'start');
          const tieStop = ties.some(t => t.getAttribute('type') === 'stop');
          const tieKey = `${text(first(el, 'voice'), '1')}:${text(first(el, 'staff'), '1')}:${midi}`;
          const prior = openTies.get(tieKey);
          const absolute = measureStart + start;
          const voice = text(first(el, 'voice'), '1');
          const staff = text(first(el, 'staff'), '1');
          const stream = `${staff}:${voice}`;
          const staccato = all(el, 'staccato').length > 0 || all(el, 'staccatissimo').length > 0;
          for (const slur of all(el, 'slur')) slurEvents.push({ scope: `${staff}:${slur.getAttribute('number') || '1'}`, stream, beat: absolute, type: slur.getAttribute('type') || '' });
          if (tieStop && prior && Math.abs(prior.beat + prior.duration - absolute) < 0.001) {
            prior.duration += duration;
            prior.tie = 'merged';
            const phrase = phraseNotes.get(prior.id);
            if (phrase && staccato) phrase.staccato = true;
            if (!tieStart) openTies.delete(tieKey);
          } else {
            if (tieStop) warn('发现未配对的延音线，已按独立音符播放。');
            const note: ScoreNote = { id: noteId, partId: staffCount > 1 ? `${id}-staff${text(first(el, 'staff'), '1')}` : id, measure: measureIndex + 1, beat: absolute, duration, midi: Math.max(0, Math.min(127, Math.round(midi))), velocity, ...(percussion !== undefined ? { percussion } : {}), ...(tieStart ? { tie: 'start' } : {}) };
            notes.push(note);
            phraseNotes.set(note.id, { stream, staccato });
            if (tieStart) openTies.set(tieKey, note);
          }
          if (all(el, 'ornaments').length || all(el, 'articulations').length) warn('装饰、奏法和踏板效果未完整应用到合成播放。');
        }
      }
      // All parts share the precomputed canonical measure start; overfull source notes remain intact.
    });
    if (openTies.size) warn('发现未闭合的延音线，请检查原谱。');
    const openSlurs = new Map<string, typeof slurEvents[number]>();
    const ambiguous = new Set<string>();
    const intervals = new Map<string, { start: number; end: number }[]>();
    for (const event of slurEvents) {
      if (event.type === 'start') {
        if (openSlurs.has(event.scope)) ambiguous.add(event.scope);
        else openSlurs.set(event.scope, event);
      } else if (event.type === 'stop') {
        const prior = openSlurs.get(event.scope);
        if (prior && !ambiguous.has(event.scope) && prior.stream === event.stream && event.beat > prior.beat) {
          const list = intervals.get(event.stream) || [];
          list.push({ start: prior.beat, end: event.beat }); intervals.set(event.stream, list);
        } else warn('部分连奏线未闭合或声部归属不明确，未推测连奏效果。');
        openSlurs.delete(event.scope); ambiguous.delete(event.scope);
      }
    }
    if (openSlurs.size) warn('部分连奏线未闭合或声部归属不明确，未推测连奏效果。');
    const streams = new Map<string, ScoreNote[]>();
    for (const note of notes) {
      const stream = phraseNotes.get(note.id)!.stream;
      const list = streams.get(stream) || []; list.push(note); streams.set(stream, list);
    }
    for (const [stream, list] of streams) {
      const spans = (intervals.get(stream) || []).sort((a, b) => a.start - b.start);
      if (!spans.length) continue;
      list.sort((a, b) => a.beat - b.beat);
      let spanIndex = 0; let coveredEnd = -Infinity;
      for (let index = 0; index < list.length;) {
        let next = index + 1;
        while (next < list.length && Math.abs(list[next].beat - list[index].beat) < 1e-7) next++;
        while (spanIndex < spans.length && spans[spanIndex].start <= list[index].beat + 1e-7) coveredEnd = Math.max(coveredEnd, spans[spanIndex++].end);
        if (next < list.length && list[next].beat <= coveredEnd + 1e-7) {
          for (let chord = index; chord < next; chord++) {
            const note = list[chord];
            if (note.percussion === undefined && !phraseNotes.get(note.id)!.staccato && Math.abs(note.beat + note.duration - list[next].beat) < .001) note.legato = true;
          }
        }
        index = next;
      }
    }
    const rawName = def ? text(first(def, 'part-name')) : '';
    const name = displayPartName(rawName, partIndex);
    const instrumentName = def ? text(all(def, 'instrument-name')[0]) : '';
    const piano = /\bpiano\b|钢琴/i.test(`${rawName} ${instrumentName}`) || (!!instrumentEl && program <= 3);
    if (staffCount > 1) return Array.from({ length: staffCount }, (_, staff) => {
      const staffId = `${id}-staff${staff + 1}`;
      const suffix = staffCount === 2 && piano ? (staff === 0 ? '右手' : '左手') : `谱表 ${staff + 1}`;
      return { id: staffId, sourcePartId: id, name: `${name} · ${suffix}`, instrument: program, notes: notes.filter(note => note.partId === staffId) };
    });
    return [{ id, sourcePartId: id, name, instrument: program, notes }];
  });
  if (!parts.length || !measures.length) throw new Error('MusicXML 没有可读取的声部或小节。');
  for (const warning of scoreDetailWarnings(root, tempoSeen)) warn(warning);
  if (all(root, 'pedal').length) warn('延音踏板暂未应用到合成播放。');
  const totalBeats = parts.reduce((end, part) => part.notes.reduce((last, note) => Math.max(last, note.beat + note.duration), end), measures.reduce((end, measure) => Math.max(end, measure.startBeat + measure.duration), 0));
  const repeatResult = buildRepeatPlayback(root, measures, totalBeats);
  for (const warning of repeatResult.warnings) warn(warning);
  const playback = warnings.has('识别小节时值不齐，已按各小节最长声部对齐，可能拉长原小节，请对照原稿核对。') && repeatResult.playback.expanded
    ? { segments: [{ sourceStart: 0, sourceEnd: totalBeats, playStart: 0 }], totalBeats, expanded: false }
    : repeatResult.playback;
  if (repeatResult.playback.expanded && !playback.expanded) warn('声部时间线不一致，无法安全展开反复，已按源谱顺序直奏。');
  return { playback, title: text(all(root, 'work-title')[0], text(all(root, 'movement-title')[0], '未命名乐谱')), composer: text(all(root, 'creator').find(el => el.getAttribute('type') === 'composer'), '未知作曲者'), tempo, beatsPerMeasure: initialBeats, parts, measures, totalBeats, warnings: [...warnings], xml: serialize(doc) };
}
function setPitch(pitch: XmlElement, midi: number, fifths?: number): void {
  const doc = pitch.ownerDocument!;
  const pitchNames = ['C', 'C', 'D', 'E', 'E', 'F', 'F', 'G', 'A', 'A', 'B', 'B'];
  const alters = [0, 1, 0, -1, 0, 0, 1, 0, -1, 0, -1, 0];
  const pc = ((midi % 12) + 12) % 12;
  let step = pitchNames[pc];
  let alter = alters[pc];
  if (fifths !== undefined) {
    const order = fifths < 0 ? ['B', 'E', 'A', 'D', 'G', 'C', 'F'] : ['F', 'C', 'G', 'D', 'A', 'E', 'B'];
    const keyAlter = new Map(order.slice(0, Math.abs(fifths)).map(name => [name, fifths < 0 ? -1 : 1]));
    let best = Infinity;
    for (const [name, natural] of Object.entries(pitchClasses)) {
      for (const accidental of [-1, 0, 1]) {
        if ((natural + accidental + 12) % 12 !== pc) continue;
        const cost = Math.abs(accidental - (keyAlter.get(name) || 0)) * 4 + Math.abs(accidental) * .1 + (accidental && Math.sign(accidental) !== Math.sign(fifths) ? .01 : 0);
        if (cost < best) { best = cost; step = name; alter = accidental; }
      }
    }
  }
  for (const node of [...children(pitch)]) pitch.removeChild(node);
  const append = (name: string, content: string) => { const el = doc.createElement(name); el.appendChild(doc.createTextNode(content)); pitch.appendChild(el); };
  append('step', step);
  if (alter) append('alter', String(alter));
  append('octave', String((midi - pitchClasses[step] - alter) / 12 - 1));
  // Let the notation renderer compute accidentals rather than retaining stale signs.
  const note = pitch.parentNode as XmlElement;
  for (const accidental of children(note, 'accidental')) note.removeChild(accidental);
}
function validSemitones(semitones: number): number {
  if (!Number.isFinite(semitones) || !Number.isInteger(semitones) || Math.abs(semitones) > 48) throw new Error('移调须为 -48 到 48 之间的整数半音。');
  return semitones;
}
export function transposeXml(xml: string, semitones: number): string {
  validSemitones(semitones);
  const doc = parseXml(xml);
  if (semitones === 0) return serialize(doc);
  const root = doc.documentElement!;
  // Shift signatures first, then spell each pitch against its active target key.
  const shiftedFifths = (source: number) => {
    let next = source + semitones * 7;
    while (next > 6) next -= 12;
    while (next < -5) next += 12;
    return next;
  };
  for (const part of children(root, 'part')) {
    let defaultKey = shiftedFifths(0);
    const staffKeys = new Map<string, number>();
    for (const measure of children(part, 'measure')) {
      for (const element of children(measure)) {
        if (element.tagName === 'attributes') {
          for (const key of children(element, 'key')) {
            const fifths = first(key, 'fifths');
            if (!fifths) continue;
            const next = shiftedFifths(Number(text(fifths)) || 0);
            fifths.textContent = String(next);
            const staff = key.getAttribute('number');
            if (staff) staffKeys.set(staff, next);
            else { defaultKey = next; staffKeys.clear(); }
          }
        } else if (element.tagName === 'note') {
          const pitch = first(element, 'pitch');
          if (pitch) setPitch(pitch, Math.max(0, Math.min(127, Math.round(pitchMidi(pitch) + semitones))), staffKeys.get(text(first(element, 'staff'), '1')) ?? defaultKey);
        }
      }
    }
  }
  return serialize(doc);
}
export function updateNoteXml(xml: string, noteId: string, midi: number): string {
  if (!Number.isInteger(midi) || midi < 0 || midi > 127) throw new Error('音高须为 0 到 127 之间的 MIDI 整数。');
  const doc = parseXml(xml);
  const note = all(doc.documentElement!, 'note').find(el => el.getAttribute('id') === noteId);
  const pitch = note && first(note, 'pitch');
  if (!pitch) throw new Error('找不到要修改的音符，请重新载入乐谱。');
  // Keep the connected tied chain at the same pitch after a correction.
  const oldMidi = pitchMidi(pitch);
  let ancestor: Node | null = note;
  while (ancestor && ancestor.nodeName !== 'part') ancestor = ancestor.parentNode;
  const voice = text(first(note!, 'voice'), '1');
  const staff = text(first(note!, 'staff'), '1');
  const hasTie = (el: XmlElement, type: string) => [...children(el, 'tie'), ...all(el, 'tied')].some(t => t.getAttribute('type') === type);
  type TimedNote = { element: XmlElement; start: number; end: number };
  const records: TimedNote[] = [];
  const recordMeasures = new Map<XmlElement, number>();
  const measureLengths: number[] = [];
  // Read the same raw timing rules as readScore, including its shared longest-part
  // measure boundaries. Never bridge a gap introduced by rests or an overfull part.
  for (const part of children(doc.documentElement!, 'part')) {
    let divisions = 1;
    let meter = 4;
    children(part, 'measure').forEach((measure, measureIndex) => {
      let cursor = 0;
      let extent = 0;
      let previous = 0;
      for (const element of children(measure)) {
        if (element.tagName === 'attributes') {
          divisions = Math.max(1, value(element, 'divisions', divisions));
          const time = first(element, 'time');
          if (time) {
            const numerator = text(first(time, 'beats'), '4').split('+').reduce((sum, beat) => sum + (Number(beat) || 0), 0);
            const next = numerator * 4 / value(time, 'beat-type', 4);
            if (next > 0 && Number.isFinite(next)) meter = next;
          }
        } else if (element.tagName === 'backup') cursor = Math.max(0, cursor - value(element, 'duration') / divisions);
        else if (element.tagName === 'forward') { cursor += value(element, 'duration') / divisions; extent = Math.max(extent, cursor); }
        else if (element.tagName === 'note' && !first(element, 'grace')) {
          const duration = Math.max(0, value(element, 'duration') / divisions);
          const chord = !!first(element, 'chord');
          const start = chord ? previous : cursor;
          if (!chord) { previous = start; cursor += duration; }
          extent = Math.max(extent, cursor, start + duration);
          if (first(element, 'cue')) continue;
          const p = first(element, 'pitch');
          if (part === ancestor && p && duration > 0 && !first(element, 'rest') && pitchMidi(p) === oldMidi && text(first(element, 'voice'), '1') === voice && text(first(element, 'staff'), '1') === staff) {
            // Store measure index temporarily; offset after all parts establish boundaries.
            records.push({ element, start, end: start + duration });
            recordMeasures.set(element, measureIndex);
          }
        }
      }
      const duration = measure.getAttribute('implicit') === 'yes' && extent > 0 ? extent : Math.max(meter, extent);
      measureLengths[measureIndex] = Math.max(measureLengths[measureIndex] || 0, duration);
    });
  }
  let offset = 0;
  const measureStarts = measureLengths.map(duration => { const start = offset; offset += duration; return start; });
  for (const record of records) { const start = measureStarts[recordMeasures.get(record.element)!]; record.start += start; record.end += start; }
  const selected = records.find(record => record.element === note);
  const starts = new Map<string, TimedNote[]>();
  const ends = new Map<string, TimedNote[]>();
  const timeKey = (beat: number) => beat.toFixed(6);
  for (const record of records) {
    const add = (map: Map<string, TimedNote[]>, beat: number) => { const key = timeKey(beat); const list = map.get(key) || []; list.push(record); map.set(key, list); };
    add(starts, record.start); add(ends, record.end);
  }
  const chain = new Set<TimedNote>();
  const pending = selected ? [selected] : [];
  while (pending.length) {
    const current = pending.pop()!;
    if (chain.has(current)) continue;
    chain.add(current);
    if (hasTie(current.element, 'start')) {
      const successors = (starts.get(timeKey(current.end)) || []).filter(record => hasTie(record.element, 'stop'));
      const predecessors = (ends.get(timeKey(current.end)) || []).filter(record => hasTie(record.element, 'start'));
      if (successors.length === 1 && predecessors.length === 1) pending.push(successors[0]);
    }
    if (hasTie(current.element, 'stop')) {
      const predecessors = (ends.get(timeKey(current.start)) || []).filter(record => hasTie(record.element, 'start'));
      const successors = (starts.get(timeKey(current.start)) || []).filter(record => hasTie(record.element, 'stop'));
      if (predecessors.length === 1 && successors.length === 1) pending.push(predecessors[0]);
    }
  }
  if (!selected) setPitch(pitch, midi);
  for (const record of chain) setPitch(first(record.element, 'pitch')!, midi);
  return serialize(doc);
}
