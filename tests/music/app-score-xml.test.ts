import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { readScore } from '../../src/music/index';
import { editScoreMetadata, readInitialMeter, sourcePartName } from '../../src/app/score-xml';
import type { XmlDom } from '../../src/app/score-xml';
import {
  effectiveMutedParts,
  exportFileBase,
  measureIndexAt,
  noteLabel,
  pitchName,
  practiceSummary,
  tempoPresets,
} from '../../src/app/score-helpers';

const dom: XmlDom = {
  parse: xml => new DOMParser().parseFromString(xml, 'application/xml') as unknown as Document,
  serialize: doc => new XMLSerializer().serializeToString(doc as unknown as Node),
};
const parse = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml');
const text = (xml: string, tag: string) => parse(xml).getElementsByTagName(tag)[0]?.textContent;

const body = `<part-list><score-part id="P1"><part-name>Voice 1</part-name></score-part><score-part id="P2"><part-name></part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>3</beats><beat-type>8</beat-type></time></attributes><note id="n1"><pitch><step>C</step><octave>4</octave></pitch><duration>3</duration></note></measure>
<measure number="2"><note id="n2"><pitch><step>D</step><octave>4</octave></pitch><duration>3</duration></note></measure></part>
<part id="P2"><measure number="1"><note><rest/><duration>3</duration></note></measure><measure number="2"><note><rest/><duration>3</duration></note></measure></part>`;
const bare = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0">${body}</score-partwise>`;
const withMetadata = `<?xml version="1.0" encoding="UTF-8"?><score-partwise version="4.0"><work><work-number>7</work-number><work-title>Old</work-title></work><identification><creator type="lyricist">Poet</creator><creator type="composer">Old composer</creator></identification>${body}</score-partwise>`;

test('editScoreMetadata adds work and identification in MusicXML order when missing', () => {
  const result = editScoreMetadata(bare, { title: '  晨光  ', composer: ' 某人 ' }, dom);
  const root = parse(result).documentElement;
  const elements = Array.from(root.childNodes).filter(node => node.nodeType === 1) as unknown as Element[];
  assert.deepEqual(
    elements.slice(0, 3).map(el => el.tagName),
    ['work', 'identification', 'part-list'],
  );
  assert.equal(text(result, 'work-title'), '晨光');
  assert.equal(text(result, 'creator'), '某人');
  assert.equal(parse(result).getElementsByTagName('creator')[0].getAttribute('type'), 'composer');
});

test('editScoreMetadata edits existing elements in place and keeps unrelated metadata', () => {
  const result = editScoreMetadata(withMetadata, { title: '', composer: 'x'.repeat(250) }, dom);
  const doc = parse(result);
  assert.equal(doc.getElementsByTagName('work').length, 1);
  assert.equal(text(result, 'work-number'), '7');
  assert.equal(text(result, 'work-title'), '未命名乐谱');
  const creators = Array.from(doc.getElementsByTagName('creator'));
  assert.deepEqual(
    creators.map(el => [el.getAttribute('type'), el.textContent?.length]),
    [
      ['lyricist', 4],
      ['composer', 200],
    ],
  );
  assert.equal(doc.getElementsByTagName('note').length, 4);
});

test('editScoreMetadata rejects a document the parser marked as broken', () => {
  const broken: XmlDom = { ...dom, parse: () => dom.parse('<html><parsererror>bad</parsererror></html>') };
  assert.throws(() => editScoreMetadata(bare, { title: 'a', composer: 'b' }, broken), /无法解析/);
});

test('readInitialMeter reads the first time signature and falls back to 4/4 values', () => {
  assert.deepEqual(readInitialMeter(bare, dom), { beats: 3, beatType: 8 });
  assert.deepEqual(readInitialMeter(bare.replace('<beats>3</beats>', '<beats>40</beats>'), dom), {
    beats: 4,
    beatType: 8,
  });
  assert.deepEqual(readInitialMeter(bare.replace('<beat-type>8</beat-type>', '<beat-type>3</beat-type>'), dom), {
    beats: 3,
    beatType: 4,
  });
  assert.deepEqual(readInitialMeter(bare.replace(/<time>.*?<\/time>/, ''), dom), { beats: 4, beatType: 4 });
});

test('sourcePartName returns the raw part-name or undefined when empty or missing', () => {
  assert.equal(sourcePartName(bare, 'P1', dom), 'Voice 1');
  assert.equal(sourcePartName(bare, 'P2', dom), undefined);
  assert.equal(sourcePartName(bare, 'P9', dom), undefined);
});

test('score helpers derive labels, measure position and practice summary', async () => {
  const score = await readScore(bare);
  assert.equal(pitchName(60), 'C4');
  assert.equal(pitchName(61), 'C♯4');
  assert.equal(pitchName(0), 'C-1');
  assert.equal(measureIndexAt(null, 10), 0);
  assert.equal(measureIndexAt(score, 0), 0);
  const second = score.measures[1].startBeat;
  assert.equal(measureIndexAt(score, second - 0.0005), 1);
  assert.equal(measureIndexAt(score, second - 0.01), 0);
  const note = score.parts[0].notes[1];
  assert.match(noteLabel(score, note), /^D4 · .+ · 第 1 拍$/);

  const [p1, p2] = score.parts.map(part => part.id);
  assert.deepEqual(effectiveMutedParts(score, p1, []), [p2]);
  assert.deepEqual(effectiveMutedParts(score, null, [p2]), [p2]);
  const base = { score, solo: null, muted: [], loop: false, loopStart: 1, loopEnd: 2, transpose: 0 };
  assert.deepEqual(practiceSummary(base), { text: '全部声部 · 整首播放 · 原调', allPartsMuted: false });
  assert.equal(
    practiceSummary({ ...base, muted: [p2], loop: true, transpose: 2 }).text,
    '已静音 1 部 · 循环 1 至 2 小节 · 移调 +2 半音',
  );
  assert.equal(practiceSummary({ ...base, muted: [p1, p2] }).allPartsMuted, true);
  assert.equal(practiceSummary({ ...base, muted: [p1, p2], solo: p1 }).allPartsMuted, false);
  assert.equal(practiceSummary({ ...base, score: null }).text, '全部声部 · 整首播放 · 原调');
});

test('tempo presets and export filenames', () => {
  assert.deepEqual(tempoPresets(null), { baseTempo: 100, slowTempo: 75, fullTempo: 100 });
  const score = { tempo: 300 } as Parameters<typeof tempoPresets>[0];
  assert.deepEqual(tempoPresets(score), { baseTempo: 300, slowTempo: 225, fullTempo: 240 });
  assert.equal(exportFileBase('a/b:c*?"<>|d'), 'a_b_c______d');
  assert.equal(exportFileBase(''), 'score');
});
