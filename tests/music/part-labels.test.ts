import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { displayPartName, translatePartName, updatePartNameXml } from '../../src/music/part-labels';

const source = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0"><work><work-title>Original title</work-title></work><identification><creator type="composer">Original composer</creator></identification><part-list><score-part id="P1"><part-name font-family="serif">Voice 1</part-name><part-abbreviation>V1</part-abbreviation><score-instrument id="I1"><instrument-name>Choir</instrument-name></score-instrument><midi-instrument id="I1"><midi-channel>1</midi-channel><midi-program>53</midi-program></midi-instrument></score-part><score-part id="P2"><part-name>Voice 2</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><staves>2</staves></attributes><note id="n1"><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note></measure></part><part id="P2"><measure number="1"><note><rest/><duration>4</duration></note></measure></part></score-partwise>`;
const parse = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml');
const serialize = (node: Node) => new XMLSerializer().serializeToString(node);
const names = (xml: string) => Array.from(parse(xml).getElementsByTagName('part-name')).map(node => node.textContent);

test('empty and generic numbered source names use caller ordinal, never source number', () => {
  for (const name of ['', ' ', 'Voice', 'voice1', 'VOICE 007', 'Part', 'Part 2', 'Instrument_9', 'Instrument #2', 'Part-5']) assert.equal(displayPartName(name, 3), '声部4');
  for (const index of [-1, 1.5, NaN, Infinity]) assert.throws(() => displayPartName('Voice', index), /序号/);
  assert.equal(displayPartName('Voice1', 0), '声部1');
  assert.equal(displayPartName('Voice1', 1), '声部2');
});

test('only explicit dictionary voice terms translate and original spelling remains visible', () => {
  const expected = [['Soprano1', '女高音1（Soprano1）'], [' Alto 2 ', '女低音2（Alto 2）'], ['Tenor', '男高音（Tenor）'], ['Baritone3', '男中音3（Baritone3）'], ['bass', '男低音（bass）']];
  for (const [raw, label] of expected) { assert.equal(displayPartName(raw, 0), label); assert.equal(translatePartName(raw), label); }
  for (const raw of ['Piano', 'Sop1', 'Sop2', 'Alt1', 'Alt2', 'Soprano Saxophone', 'Bass Clarinet', 'Contrabass', 'Voice of Spring', 'Partita', 'S.A.T.B.', '女高音', 'Upper staff', 'Soprano I']) assert.equal(displayPartName(raw, 0), raw);
  assert.equal(displayPartName('Piano', 0), displayPartName('Piano', 1)); // UI supplies independent ordinal for duplicates.
});

test('rename only edits exact source part-name while preserving notes, IDs, metadata and instruments', () => {
  const before = parse(source); const original = source;
  const result = updatePartNameXml(source, 'P1', '  主旋律 & <伴奏>  ');
  assert.deepEqual(names(result), ['主旋律 & <伴奏>', 'Voice 2']);
  assert.match(result, /主旋律 &amp; &lt;伴奏&gt;/);
  const after = parse(result);
  for (const tag of ['part', 'work', 'identification', 'part-abbreviation', 'score-instrument', 'midi-instrument']) assert.deepEqual(Array.from(after.getElementsByTagName(tag)).map(serialize), Array.from(before.getElementsByTagName(tag)).map(serialize));
  assert.equal(after.getElementsByTagName('part-name')[0].getAttribute('font-family'), 'serif');
  assert.equal(source, original);
  assert.equal(after.getElementsByTagName('score-part')[0].getAttribute('id'), 'P1');
  assert.throws(() => updatePartNameXml(source, 'P1-staff1', '右手'), /源声部编号/);
});

test('missing part-name is inserted in its own definition without changing abbreviation', () => {
  const xml = '<score-partwise><part-list><score-part id="P"><identification><creator>A</creator></identification><part-abbreviation>Keep</part-abbreviation></score-part></part-list><part id="P"/></score-partwise>';
  const result = parse(updatePartNameXml(xml, 'P', 'New'));
  const definition = result.getElementsByTagName('score-part')[0];
  assert.deepEqual(Array.from(definition.childNodes).filter(n => n.nodeType === 1).map(n => n.nodeName), ['identification', 'part-name', 'part-abbreviation']);
  assert.equal(result.getElementsByTagName('part-abbreviation')[0].textContent, 'Keep');
});

test('name validation trims ends, counts Unicode code points and rejects controls or invalid length', () => {
  assert.equal(names(updatePartNameXml(source, 'P1', '  A  '))[0], 'A');
  assert.equal(names(updatePartNameXml(source, 'P1', '🎹'.repeat(80)))[0], '🎹'.repeat(80));
  for (const invalid of ['', '   ', 'a'.repeat(81), '🎹'.repeat(81), 'a\nb', '\tName', 'a\u0000b', 'a\u007fb', 'a\u0085b', 'a\u202eb', 'a\u2066b']) assert.throws(() => updatePartNameXml(source, 'P1', invalid), /名称/);
  for (const invalidId of ['', '  ', 'P1\n']) assert.throws(() => updatePartNameXml(source, invalidId, 'Name'), /编号/);
});

test('unknown, duplicate or structurally misplaced source definitions are rejected', () => {
  assert.throws(() => updatePartNameXml(source, 'missing', 'Name'), /未找到/);
  for (const xml of [
    '<score-partwise><part-list><score-part id="P"><part-name>A</part-name></score-part><score-part id="P"><part-name>B</part-name></score-part></part-list></score-partwise>',
    '<score-partwise><part-list><score-part id="P"><part-name>A</part-name><part-name>B</part-name></score-part></part-list></score-partwise>',
    '<score-partwise><part-list/><part-list/></score-partwise>',
    '<score-partwise><wrapper><part-list><score-part id="P"/></part-list></wrapper></score-partwise>',
  ]) assert.throws(() => updatePartNameXml(xml, 'P', 'Name'), /重复|唯一/);
});

test('malformed XML, custom entities and foreign namespaces fail instead of parser recovery', () => {
  for (const xml of [
    '', '<score-partwise><part-list></score-partwise>', '<score-partwise/><extra/>',
    '<score-partwise><part-list><score-part id=P/></part-list></score-partwise>',
    '<!DOCTYPE score-partwise [<!ENTITY x SYSTEM "file:///etc/passwd">]><score-partwise/>',
    '<!DOCTYPE score-partwise [<!ENTITY x "name">]><score-partwise/>',
    '<score-partwise xmlns="urn:external"><part-list><score-part id="P"/></part-list></score-partwise>',
    '<score-partwise xmlns:ext="urn:external"><part-list><score-part id="P"/></part-list></score-partwise>',
    '<score-partwise><part-list><score-part id="P"><part-name xmlns="urn:external">A</part-name></score-part></part-list></score-partwise>',
  ]) assert.throws(() => updatePartNameXml(xml, 'P', 'Name'), /XML|MusicXML|实体|乐谱为空/);
});

test('ordinary external MusicXML doctype remains inert and is preserved; standard namespaces work', () => {
  const doctype = '<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">';
  const result = updatePartNameXml(source.replace('<?xml version="1.0" encoding="UTF-8"?>', doctype), 'P1', 'New');
  assert.deepEqual(names(result), ['New', 'Voice 2']); assert.ok(result.includes(doctype));
  for (const xml of [
    '<score-partwise xmlns="http://www.musicxml.org/ns/musicxml"><part-list><score-part id="P"><part-name xml:lang="en">A</part-name></score-part></part-list></score-partwise>',
    '<m:score-partwise xmlns:m="http://www.musicxml.org/ns/musicxml"><m:part-list><m:score-part id="P"/></m:part-list></m:score-partwise>',
  ]) {
    const doc = parse(updatePartNameXml(xml, 'P', 'New'));
    const node = doc.getElementsByTagNameNS('http://www.musicxml.org/ns/musicxml', 'part-name')[0];
    assert.equal(node.textContent, 'New');
  }
});
