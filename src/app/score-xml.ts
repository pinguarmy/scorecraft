// 界面层直接读写 MusicXML 的几处小操作。
// 浏览器中使用原生 DOMParser / XMLSerializer；测试可以传入 @xmldom/xmldom 的实现。

export type XmlDom = {
  parse(xml: string): Document;
  serialize(doc: Document): string;
};

export const browserXmlDom: XmlDom = {
  parse: (xml) => new DOMParser().parseFromString(xml, 'application/xml'),
  serialize: (doc) => new XMLSerializer().serializeToString(doc),
};

const elementChildren = (node: Element) =>
  Array.from(node.childNodes).filter((child): child is Element => child.nodeType === 1);

const supportedBeatTypes = [1, 2, 4, 8, 16, 32, 64];

/**
 * 拍号校正表单的初始值：取谱中第一个 <time>。
 * 分子不在 1–32 或分母不受支持时回退为 4/4 对应的值。
 */
export function readInitialMeter(xml: string, dom: XmlDom = browserXmlDom) {
  const doc = dom.parse(xml);
  const time = doc.getElementsByTagName('time')[0];
  const beats = Number(time?.getElementsByTagName('beats')[0]?.textContent);
  const beatType = Number(time?.getElementsByTagName('beat-type')[0]?.textContent);
  return {
    beats: Number.isInteger(beats) && beats >= 1 && beats <= 32 ? beats : 4,
    beatType: supportedBeatTypes.includes(beatType) ? beatType : 4,
  };
}

/**
 * 写入曲名（work/work-title）和作曲者（identification/creator[type=composer]）。
 * 缺少的元素会补上；两项都去掉首尾空白并截到 200 字符，空曲名记为“未命名乐谱”。
 * 返回序列化后的 MusicXML，原文件无法解析时抛错。
 */
export function editScoreMetadata(
  xml: string,
  drafts: { title: string; composer: string },
  dom: XmlDom = browserXmlDom,
): string {
  const doc = dom.parse(xml);
  if (doc.getElementsByTagName('parsererror').length) throw new Error('原始 MusicXML 无法解析。');
  const root = doc.documentElement;
  let work = elementChildren(root).find((el) => el.tagName === 'work');
  if (!work) {
    work = doc.createElement('work');
    root.insertBefore(work, root.firstChild);
  }
  let title = elementChildren(work).find((el) => el.tagName === 'work-title');
  if (!title) {
    title = doc.createElement('work-title');
    work.appendChild(title);
  }
  title.textContent = drafts.title.trim().slice(0, 200) || '未命名乐谱';
  let identification = elementChildren(root).find((el) => el.tagName === 'identification');
  if (!identification) {
    identification = doc.createElement('identification');
    root.insertBefore(identification, work.nextSibling);
  }
  let composer = elementChildren(identification).find(
    (el) => el.tagName === 'creator' && el.getAttribute('type') === 'composer',
  );
  if (!composer) {
    composer = doc.createElement('creator');
    composer.setAttribute('type', 'composer');
    identification.appendChild(composer);
  }
  composer.textContent = drafts.composer.trim().slice(0, 200);
  return dom.serialize(doc);
}

/** 源声部（score-part）当前的 part-name 文本；找不到时返回 undefined。 */
export function sourcePartName(xml: string, sourcePartId: string, dom: XmlDom = browserXmlDom) {
  const doc = dom.parse(xml);
  const source = Array.from(doc.getElementsByTagName('score-part')).find(
    (item) => item.getAttribute('id') === sourcePartId,
  );
  return source?.getElementsByTagName('part-name')[0]?.textContent || undefined;
}
