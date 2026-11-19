import test from 'node:test';
import assert from 'node:assert/strict';
import { readScore } from '../../src/music/index';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
const n = (step = 'C', extra = '', voice = '1') => `<note>${extra}<pitch><step>${step}</step><octave>4</octave></pitch><duration>1</duration><voice>${voice}</voice></note>`;
const slur = (type: string, extra = '') => `<notations><slur type="${type}" number="1"/>${extra}</notations>`;
const wrap = (body: string) => `<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1"><measure><attributes><divisions>1</divisions></attributes>${body}</measure></part></score-partwise>`;
const dynamics = (symbol: string, sound = '') => `<direction><direction-type><dynamics><${symbol}/></dynamics></direction-type>${sound}</direction>`;

test('explicit common dynamics have fixed fallback and sound dynamics takes priority including zero', async () => {
  const symbols = ['ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff'];
  const result = await readScore(wrap(symbols.map(symbol => dynamics(symbol) + n()).join('') + dynamics('fff', '<sound dynamics="0"/>') + n() + dynamics('p', '<sound dynamics="80"/>') + n() + dynamics('f', '<sound tempo="66"/>') + n()));
  assert.deepEqual(result.parts[0].notes.map(note => note.velocity), [24, 36, 48, 60, 76, 92, 108, 120, 0, 72, 92]);
  assert.ok(!result.warnings.some(warning => warning.includes('sound dynamics')));
  const unknown = await readScore(wrap(dynamics('sfz') + n())); assert.ok(unknown.warnings.some(warning => warning.includes('固定近似值')));
});

test('closed slur marks only continuous same-voice notes without changing onsets or durations', async () => {
  const xml = wrap(n('C', slur('start')) + n('D') + n('E', slur('stop')) + n('F'));
  const result = await readScore(xml);
  assert.deepEqual(result.parts[0].notes.map(note => note.legato ?? false), [true, true, false, false]);
  assert.deepEqual(result.parts[0].notes.map(note => [note.beat, note.duration]), [[0, 1], [1, 1], [2, 1], [3, 1]]);
  assert.match(result.xml, /slur type="start"/);
  const normalize = (source: string) => { const doc = new DOMParser().parseFromString(source, 'application/xml'); for (const note of Array.from(doc.getElementsByTagName('note'))) note.removeAttribute('id'); return new XMLSerializer().serializeToString(doc); };
  assert.equal(normalize(result.xml), normalize(xml), 'only stable IDs are added to XML, no phrasing or dynamics rewrites');
});

test('same-pitch written ties merge once while slurs never merge repeated attacks or chord voices', async () => {
  const result = await readScore(wrap(n('C', '<tie type="start"/>' + slur('start')) + n('C', '<tie type="stop"/>') + n('D', slur('stop')) + '<backup><duration>3</duration></backup>' + n('G', '', '2') + n('A', '', '2') + n('B', '', '2')));
  assert.equal(result.parts[0].notes.length, 5); assert.equal(result.parts[0].notes[0].duration, 2); assert.equal(result.parts[0].notes[0].tie, 'merged');
  assert.equal(result.parts[0].notes[0].legato, true);
  assert.ok(result.parts[0].notes.slice(2).every(note => !note.legato));
  const repeated = await readScore(wrap(n('C', slur('start')) + n('C', slur('stop')))); assert.equal(repeated.parts[0].notes.length, 2);
});

test('real rests and explicit staccato suppress legato and preserve source rhythm', async () => {
  const result = await readScore(wrap(n('C', slur('start')) + '<note><rest/><duration>1</duration><voice>1</voice></note>' + n('D', '<notations><articulations><staccato/></articulations></notations>') + n('E', slur('stop'))));
  assert.ok(result.parts[0].notes.every(note => !note.legato));
  assert.deepEqual(result.parts[0].notes.map(note => note.beat), [0, 2, 3]);
});

test('ambiguous or unclosed slurs do not leak into other parts or voices, chord groups retain timing', async () => {
  const xml = wrap(n('C', slur('start')) + '<backup><duration>1</duration></backup>' + n('G', slur('stop'), '2')).replace('</score-partwise>', `<part id="P2"><measure>${n('A')}${n('B')}</measure></part></score-partwise>`);
  const result = await readScore(xml); assert.ok(result.parts.every(part => part.notes.every(note => !note.legato))); assert.ok(result.warnings.some(warning => warning.includes('归属不明确')));
  const unclosed = await readScore(wrap(n('C', slur('start')) + n('D'))); assert.ok(unclosed.parts[0].notes.every(note => !note.legato));
  const chord = await readScore(wrap(n('C', slur('start')) + n('E', '<chord/>') + n('D', slur('stop'))));
  assert.deepEqual(chord.parts[0].notes.map(note => [note.beat, !!note.legato]), [[0, true], [0, true], [1, false]]);
});
