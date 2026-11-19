import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { zipSync, strToU8 } from 'fflate';
import { readScore, transposeXml, updateNoteXml } from '../../src/music/index';

const wrap = (body: string, metadata = '') => `<?xml version="1.0"?><score-partwise version="4.0"><work><work-title>Test</work-title></work><part-list><score-part id="P1"><part-name>Piano</part-name><midi-instrument id="I1"><midi-program>1</midi-program></midi-instrument></score-part></part-list>${metadata}<part id="P1">${body}</part></score-partwise>`;
const note = (pitch = 'C', duration = 4, extra = '') => `<note>${extra}<pitch><step>${pitch}</step><octave>4</octave></pitch><duration>${duration}</duration><voice>1</voice></note>`;
const attributes = '<attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>';

test('original CC0 piano fixture has 8 measures, stable IDs and independent hands', async () => {
  const xml = await readFile('public/samples/first-light.musicxml', 'utf8');
  const score = await readScore(xml);
  assert.equal(score.title, 'First Light · 初光');
  assert.equal(score.tempo, 88);
  assert.equal(score.totalBeats, 32);
  assert.equal(score.measures.length, 8);
  assert.equal(score.measures[4].startBeat, 16);
  assert.deepEqual(score.parts.map(p => p.id), ['P1-staff1', 'P1-staff2']);
  assert.equal(score.parts[0].notes.length, 23);
  assert.equal(score.parts[1].notes.length, 15);
  assert.equal(score.parts[0].notes[0].id, 'p0-m0-n0');
  assert.equal(score.parts[1].notes[0].beat, 0);
  assert.equal(score.warnings.length, 0);
  assert.match(score.xml, /CC0 1.0 Universal/);
  const reread = await readScore(score.xml);
  assert.deepEqual(reread.parts.flatMap(p => p.notes.map(n => n.id)), score.parts.flatMap(p => p.notes.map(n => n.id)));
});

test('backup, forward, chord, rest and tied continuation preserve quarter beats', async () => {
  const xml = wrap(`<measure number="1">${attributes}${note('C', 8, '<tie type="start"/>')}${note('E', 8, '<chord/>')}<forward><duration>4</duration></forward><note><rest/><duration>4</duration></note><backup><duration>16</duration></backup><note><pitch><step>G</step><octave>3</octave></pitch><duration>16</duration><voice>2</voice></note></measure><measure number="2">${note('C', 8, '<tie type="stop"/>')}${note('D', 8)}</measure>`);
  const score = await readScore(xml);
  const notes = score.parts[0].notes;
  assert.deepEqual(notes.map(n => [n.midi, n.beat, n.duration]), [[60, 0, 2], [64, 0, 2], [55, 0, 4], [60, 4, 2], [62, 6, 2]]);
  // Non-contiguous tie at beat 2->4 cannot be sustained and must warn.
  assert.ok(score.warnings.some(w => w.includes('未配对')));
});

test('tie chains merge and correction updates connected continuations', async () => {
  const xml = wrap(`<measure number="1">${attributes}${note('C', 16, '<tie type="start"/>')}</measure><measure number="2">${note('C', 16, '<tie type="stop"/>')}</measure>`);
  const score = await readScore(xml);
  assert.equal(score.parts[0].notes.length, 1);
  assert.equal(score.parts[0].notes[0].duration, 8);
  const corrected = await readScore(updateNoteXml(score.xml, 'p0-m0-n0', 61));
  assert.equal(corrected.parts[0].notes.length, 1);
  assert.equal(corrected.parts[0].notes[0].midi, 61);
  assert.equal(corrected.parts[0].notes[0].duration, 8);
});

test('MXL reads declared container root, ArrayBuffer and utf16 XML work', async () => {
  const xml = wrap(`<measure number="1">${attributes}${note()}</measure>`);
  const zipped = zipSync({ 'META-INF/container.xml': strToU8('<container><rootfiles><rootfile full-path="scores/main.musicxml"/></rootfiles></container>'), 'scores/main.musicxml': strToU8(xml) });
  assert.equal((await readScore(zipped)).parts[0].notes[0].midi, 60);
  const bytes = new Uint8Array(strToU8(xml));
  assert.equal((await readScore(bytes.buffer)).measures.length, 1);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
  assert.equal((await readScore(utf16)).title, 'Test');
});

test('transpose preserves IDs and corrects key and explicit accidental', async () => {
  const xml = wrap(`<measure number="1">${attributes.replace('<time>', '<key><fifths>0</fifths></key><time>')}${note('C', 4, '<accidental>natural</accidental>')}</measure>`);
  const original = await readScore(xml);
  assert.match(transposeXml(original.xml, 0), /<accidental>natural<\/accidental>/);
  const shifted = await readScore(transposeXml(original.xml, 2));
  assert.equal(shifted.parts[0].notes[0].midi, 62);
  assert.equal(shifted.parts[0].notes[0].id, original.parts[0].notes[0].id);
  assert.match(shifted.xml, /<fifths>2<\/fifths>/);
  assert.doesNotMatch(shifted.xml, /<accidental>/);
  assert.throws(() => updateNoteXml(original.xml, 'missing', 60), /找不到/);
  assert.throws(() => updateNoteXml(original.xml, 'p0-m0-n0', 128), /音高/);
  assert.throws(() => transposeXml(original.xml, NaN), /移调/);
});

test('transposed scales use the target key spelling, including flats and octave boundaries', async () => {
  const source = wrap(`<measure number="1">${attributes.replace('<time>', '<key><fifths>0</fifths></key><time>')}${['C', 'D', 'E', 'F', 'G', 'A', 'B'].map(step => note(step)).join('')}</measure>`);
  const spelling = (xml: string) => Array.from(xml.matchAll(/<pitch><step>([A-G])<\/step>(?:<alter>(-?\d)<\/alter>)?<octave>(-?\d+)<\/octave><\/pitch>/g), match => [match[1], Number(match[2] || 0), Number(match[3])]);
  const flat = transposeXml(source, 1);
  assert.match(flat, /<fifths>-5<\/fifths>/);
  assert.deepEqual(spelling(flat), [['D', -1, 4], ['E', -1, 4], ['F', 0, 4], ['G', -1, 4], ['A', -1, 4], ['B', -1, 4], ['C', 0, 5]]);
  assert.deepEqual(spelling(transposeXml(source, 6)), [['F', 1, 4], ['G', 1, 4], ['A', 1, 4], ['B', 0, 4], ['C', 1, 5], ['D', 1, 5], ['E', 1, 5]]);
  assert.deepEqual((await readScore(flat)).parts[0].notes.map(n => n.midi), [61, 63, 65, 66, 68, 70, 72]);
});

test('pickup duration, tempo/time changes and repeats are honest', async () => {
  const xml = wrap(`<measure number="0" implicit="yes">${attributes}<direction><sound tempo="92"/></direction>${note()}</measure><measure number="1"><attributes><time><beats>3</beats><beat-type>4</beat-type></time></attributes><direction><sound tempo="120"/></direction>${note('D', 12)}<barline><repeat direction="backward"/></barline></measure>`);
  const score = await readScore(xml);
  assert.equal(score.tempo, 92);
  assert.equal(score.measures[0].duration, 1);
  assert.equal(score.measures[1].startBeat, 1);
  assert.equal(score.totalBeats, 4);
  assert.equal(score.playback?.expanded, true);
  assert.equal(score.playback?.totalBeats, 8);
  assert.equal(score.warnings.length, 2);
});

test('malformed, unsafe and unsupported XML fail with actionable errors', async () => {
  await assert.rejects(readScore('<score-partwise><part></score-partwise>'), /格式无效/);
  await assert.rejects(readScore('<score-partwise><part id=P1/></score-partwise>'), /格式无效/);
  await assert.rejects(readScore('<score-timewise/>'), /score-partwise/);
  await assert.rejects(readScore('<!DOCTYPE a [<!ENTITY x "a">]><score-partwise/>'), /实体/);
  await assert.rejects(readScore(''), /为空/);
  await assert.rejects(readScore('<score-partwise/>'), /没有/);
});

test('cue notes participate in timing and extent calculation without sounding, normal and chord notes follow', async () => {
  const cueXml = wrap(`<measure number="1">${attributes}<note><cue/><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>${note('D', 4)}<note><cue/><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>${note('G', 4, '<chord/>')}</measure>`);
  const score = await readScore(cueXml);
  const notes = score.parts[0].notes;
  assert.equal(notes.length, 2, 'cue notes do not sound and are not emitted in score notes');
  assert.equal(notes[0].midi, 62, 'D4 sounds');
  assert.equal(notes[0].beat, 1, 'cue note duration (1 beat) advanced cursor for following normal note');
  assert.equal(notes[0].duration, 1);
  assert.equal(notes[1].midi, 67, 'G4 sounds');
  assert.equal(notes[1].beat, 2, 'cue note established previous note position for chord note');
  assert.equal(notes[1].duration, 1);
  assert.equal(score.measures[0].duration, 4);
});
