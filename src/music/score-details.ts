import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

const children = (element: Element, tag?: string): Element[] =>
  Array.from(element.childNodes).filter((node) => node.nodeType === 1 && (!tag || node.nodeName === tag)) as Element[];
function documentForEdit(xml: string): Document {
  if (!xml.trim() || xml.length > 20 * 1024 * 1024) throw new Error('乐谱为空或超过 20 MB 限制。');
  if (/<!ENTITY\b/i.test(xml) || /<!DOCTYPE[^>]*\[/i.test(xml)) throw new Error('不支持带自定义实体的 XML。');
  let problem = '';
  let doc: Document;
  try {
    doc = new DOMParser({
      errorHandler: (_level, message) => {
        problem = String(message);
      },
    }).parseFromString(xml.replace(/<!DOCTYPE[^>]*>/gi, ''), 'application/xml');
  } catch {
    throw new Error('MusicXML 格式无效，请检查文件是否完整。');
  }
  const root = doc.documentElement;
  if (problem || !root || root.tagName !== 'score-partwise')
    throw new Error('仅支持完整有效的 score-partwise MusicXML。');
  const namespace = root.namespaceURI || '';
  if (namespace && namespace !== 'http://www.musicxml.org/ns/musicxml') throw new Error('不支持外部 XML 命名空间。');
  for (const element of [root, ...Array.from(root.getElementsByTagName('*'))])
    if ((element.namespaceURI || '') !== namespace) throw new Error('不支持外部 XML 命名空间。');
  return doc;
}
/** Return only unclosed start elements. Closed lines and unrelated directions remain untouched. */
function openStarts(doc: Document): Element[] {
  const open: Element[] = [];
  for (const part of children(doc.documentElement, 'part')) {
    const scopes = new Map<string, Element[]>();
    for (const measure of children(part, 'measure')) {
      for (const direction of children(measure, 'direction')) {
        const staff = children(direction, 'staff')[0]?.textContent?.trim() || '1';
        for (const type of children(direction, 'direction-type')) {
          for (const shift of children(type, 'octave-shift')) {
            const key = `${staff}:${shift.getAttribute('number') || '1'}`;
            const starts = scopes.get(key) || [];
            const action = shift.getAttribute('type');
            if (action === 'up' || action === 'down') {
              starts.push(shift);
              scopes.set(key, starts);
            } else if (action === 'stop') {
              starts.pop();
              if (starts.length) scopes.set(key, starts);
              else scopes.delete(key);
            }
          }
        }
      }
    }
    for (const starts of scopes.values()) open.push(...starts);
  }
  return open;
}
/** Explicit meter correction at one source measure. Never rewrites durations or future meter changes. */
export function updateTimeSignatureXml(
  xml: string,
  beats: number,
  beatType: number,
  options: { measure: number; sourcePartIds?: string[] },
): string {
  if (!Number.isInteger(beats) || beats < 1 || beats > 32 || ![1, 2, 4, 8, 16, 32, 64].includes(beatType))
    throw new Error('拍号无效，分子须为 1 至 32 的整数，分母须为 1、2、4、8、16、32 或 64。');
  if (!options || !Number.isInteger(options.measure) || options.measure < 1)
    throw new Error('请选择从 1 开始的源小节序号。');
  const doc = documentForEdit(xml);
  const parts = children(doc.documentElement, 'part');
  const ids = options.sourcePartIds;
  if (ids && (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => typeof id !== 'string' || !id)))
    throw new Error('源声部编号无效或重复。');
  const selected = ids
    ? ids.map((id) => {
        const matches = parts.filter((part) => part.getAttribute('id') === id);
        if (matches.length !== 1) throw new Error('源声部编号不存在或重复。');
        return matches[0];
      })
    : parts;
  if (!selected.length) throw new Error('乐谱没有可校正的源声部。');
  const create = (name: string) =>
    doc.documentElement.namespaceURI
      ? doc.createElementNS(doc.documentElement.namespaceURI, name)
      : doc.createElement(name);
  for (const part of selected) {
    const measure = children(part, 'measure')[options.measure - 1];
    if (!measure) throw new Error('所选小节超出源声部范围。');
    const attributes = children(measure, 'attributes');
    const times = attributes.flatMap((attribute) => children(attribute, 'time'));
    if (
      times.length > 1 ||
      times.some(
        (time) =>
          time.hasAttribute('number') ||
          children(time, 'beats').length !== 1 ||
          children(time, 'beat-type').length !== 1 ||
          children(time).some((element) => !['beats', 'beat-type'].includes(element.tagName)),
      )
    )
      throw new Error('该小节包含复合或分谱表拍号，暂不支持直接校正。');
    let time = times[0];
    if (time) {
      const before = children(measure).slice(0, children(measure).indexOf(time.parentNode as Element));
      if (before.some((element) => ['note', 'backup', 'forward'].includes(element.tagName)))
        throw new Error('暂不支持小节中途的拍号校正。');
      children(time, 'beats')[0].textContent = String(beats);
      children(time, 'beat-type')[0].textContent = String(beatType);
      time.removeAttribute('symbol');
    } else {
      let attribute = attributes[0];
      if (!attribute) {
        attribute = create('attributes');
        measure.insertBefore(attribute, measure.firstChild);
      } else if (
        children(measure)
          .slice(0, children(measure).indexOf(attribute))
          .some((element) => ['note', 'backup', 'forward'].includes(element.tagName))
      )
        throw new Error('暂不支持小节中途的拍号校正。');
      time = create('time');
      const numerator = create('beats');
      numerator.textContent = String(beats);
      time.appendChild(numerator);
      const denominator = create('beat-type');
      denominator.textContent = String(beatType);
      time.appendChild(denominator);
      const following = children(attribute).find(
        (element) => !['footnote', 'level', 'divisions', 'key'].includes(element.tagName),
      );
      attribute.insertBefore(time, following || null);
    }
  }
  return new XMLSerializer().serializeToString(doc);
}
export function inspectOpenOctaveShifts(xml: string): number {
  return openStarts(documentForEdit(xml)).length;
}
/** Explicit user-reviewed correction only. Does not infer intended pitches or alter closed lines. */
export function removeOpenOctaveShiftsXml(xml: string): string {
  const doc = documentForEdit(xml);
  const starts = openStarts(doc);
  if (!starts.length) return xml;
  for (const start of starts) start.parentNode!.removeChild(start);
  return new XMLSerializer().serializeToString(doc);
}
