import { DOMParser, XMLSerializer } from '@xmldom/xmldom';

const MUSICXML_NAMESPACE = 'http://www.musicxml.org/ns/musicxml';
const XML_NAMESPACE = 'http://www.w3.org/XML/1998/namespace';
const XMLNS_NAMESPACE = 'http://www.w3.org/2000/xmlns/';
const MAX_XML_LENGTH = 20 * 1024 * 1024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
const GENERIC_NAME = /^(?:voice|part|instrument)(?:\s*[-_#.:]?\s*\d+)?$/i;
const VOICE_NAMES: Record<string, string> = {
  soprano: '女高音',
  alto: '女低音',
  tenor: '男高音',
  baritone: '男中音',
  bass: '男低音',
};

/** Translate only explicit voice terms, retaining the source spelling; never infer from notes. */
export function translatePartName(raw: string): string {
  const name = raw.trim();
  const match = /^(Soprano|Alto|Tenor|Baritone|Bass)(?:\s*(\d+))?$/i.exec(name);
  if (!match) return name;
  return `${VOICE_NAMES[match[1].toLowerCase()]}${match[2] ?? ''}（${name}）`;
}

/** The UI should still display an independent ordinal, since real source names may repeat. */
export function displayPartName(raw: string, index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('声部序号必须是从 0 开始的整数。');
  const name = raw.trim();
  return !name || GENERIC_NAME.test(name) ? `声部${index + 1}` : translatePartName(name);
}

function children(element: Element, name?: string): Element[] {
  return Array.from(element.childNodes)
    .filter((node): node is Element => node.nodeType === 1)
    .filter((node) => !name || node.localName === name);
}

/** Update one source score-part name only. Split staff IDs must be mapped by the caller. */
export function updatePartNameXml(xml: string, sourcePartId: string, newName: string): string {
  if (typeof newName !== 'string' || CONTROL_CHARACTERS.test(newName)) throw new Error('声部名称不能包含控制字符。');
  const name = newName.trim();
  if (Array.from(name).length < 1 || Array.from(name).length > 80) throw new Error('声部名称须为 1 至 80 个字符。');
  if (typeof sourcePartId !== 'string' || !sourcePartId.trim() || CONTROL_CHARACTERS.test(sourcePartId))
    throw new Error('源声部编号无效。');
  if (typeof xml !== 'string' || !xml.trim() || xml.length > MAX_XML_LENGTH)
    throw new Error('乐谱为空或超过 20 MB 限制。');
  if (/<!ENTITY\b/i.test(xml) || /<!DOCTYPE[^>]*\[/i.test(xml)) throw new Error('不支持带自定义实体的 XML。');
  let problem = '';
  let doc: Document;
  try {
    doc = new DOMParser({
      errorHandler: (_level, message) => {
        problem = String(message);
      },
    }).parseFromString(xml, 'application/xml');
  } catch {
    throw new Error('MusicXML 格式无效，请检查文件是否完整。');
  }
  const root = doc.documentElement;
  if (problem || !root || root.localName !== 'score-partwise')
    throw new Error('仅支持完整有效的 score-partwise MusicXML。');
  const namespace = root.namespaceURI || '';
  if (namespace && namespace !== MUSICXML_NAMESPACE) throw new Error('不支持外部 XML 命名空间。');
  // Reject namespace lookalikes anywhere, including unused external declarations.
  for (const element of [root, ...Array.from(root.getElementsByTagName('*'))]) {
    if ((element.namespaceURI || '') !== namespace) throw new Error('不支持外部 XML 命名空间。');
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.namespaceURI === XMLNS_NAMESPACE || attribute.name === 'xmlns') {
        if (![MUSICXML_NAMESPACE, XML_NAMESPACE].includes(attribute.value))
          throw new Error('不支持外部 XML 命名空间。');
      } else if (attribute.namespaceURI && attribute.namespaceURI !== XML_NAMESPACE)
        throw new Error('不支持外部 XML 命名空间。');
    }
  }
  const lists = children(root, 'part-list');
  if (lists.length !== 1) throw new Error('MusicXML 须包含唯一的 part-list。');
  const matches = children(lists[0], 'score-part').filter((part) => part.getAttribute('id') === sourcePartId);
  if (matches.length !== 1)
    throw new Error(matches.length ? '源声部编号重复，无法安全改名。' : '未找到对应的源声部编号。');
  const definition = matches[0];
  const names = children(definition, 'part-name');
  if (names.length > 1) throw new Error('源声部名称重复，无法安全改名。');
  let target = names[0];
  if (!target) {
    const qualifiedName = definition.prefix ? `${definition.prefix}:part-name` : 'part-name';
    target = namespace ? doc.createElementNS(namespace, qualifiedName) : doc.createElement(qualifiedName);
    const identification = children(definition, 'identification')[0];
    definition.insertBefore(target, identification ? identification.nextSibling : definition.firstChild);
  }
  target.textContent = name;
  return new XMLSerializer().serializeToString(doc);
}
