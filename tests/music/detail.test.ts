import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { readScore, inspectOpenOctaveShifts, removeOpenOctaveShiftsXml, updateTimeSignatureXml, PLAYBACK_CAPABILITY_SUMMARY } from '../../src/music/index';

const note = (duration: number, extra = '', voice = '1', step = 'C') => `<note>${extra}<pitch><step>${step}</step><octave>4</octave></pitch><duration>${duration}</duration><voice>${voice}</voice></note>`;
const attrs = '<attributes><divisions>12</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>';
const score = (body: string, name = 'Voice') => `<score-partwise><part-list><score-part id="P1"><part-name>${name}</part-name></score-part></part-list><part id="P1">${body}</part></score-partwise>`;
const shift = (type: string, number = '1', staff = '1', extra = '') => `<direction><direction-type><octave-shift type="${type}" number="${number}" size="15"/>${extra}</direction-type><staff>${staff}</staff><sound dynamics="56"/></direction>`;
const parsed = (xml: string) => new DOMParser().parseFromString(xml, 'application/xml');

test('authored dot/triplet/chord/tie/backup fixture has exact quarter-beat source timing', async () => {
  const xml = score(`<measure number="1">${attrs}<direction><sound tempo="56"/></direction>${note(18, '<type>quarter</type><dot/>')}${note(18, '<chord/>', '1', 'E')}${[0, 1, 2].map(() => note(4, '<type>eighth</type><time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>')).join('')}${note(18, '<tie type="start"/>')}<backup><duration>48</duration></backup>${note(48, '', '2', 'G')}</measure><measure number="2">${note(12, '<tie type="stop"/>')}<note><rest/><duration>36</duration><voice>1</voice></note></measure>`);
  const result = await readScore(xml);
  const notes = result.parts[0].notes;
  assert.deepEqual(notes.slice(0, 2).map(n => [n.beat, n.duration]), [[0, 1.5], [0, 1.5]]);
  assert.ok(Math.abs(notes[2].beat - 1.5) < 1e-10); assert.ok(Math.abs(notes[3].beat - 11 / 6) < 1e-10); assert.ok(Math.abs(notes[4].beat - 13 / 6) < 1e-10);
  assert.ok(notes.slice(2, 5).every(n => Math.abs(n.duration - 1 / 3) < 1e-10));
  assert.equal(notes[5].beat, 2.5); assert.equal(notes[5].duration, 2.5); assert.equal(notes[5].tie, 'merged');
  assert.deepEqual([notes[6].beat, notes[6].duration], [0, 4]);
  assert.equal(result.totalBeats, 8); assert.equal(result.tempo, 56); assert.equal(result.warnings.length, 0);
});

test('all parts use canonical longest-measure starts without dropping overfull source notes', async () => {
  const xml = `<score-partwise><part-list><score-part id="P1"><part-name>Voice</part-name></score-part><score-part id="P2"><part-name>Voice</part-name></score-part></part-list><part id="P1"><measure>${attrs}${note(54)}</measure><measure>${note(48)}</measure></part><part id="P2"><measure>${attrs}${note(48)}</measure><measure>${note(48)}</measure></part></score-partwise>`;
  const result = await readScore(xml);
  assert.deepEqual(result.measures.map(m => [m.startBeat, m.duration]), [[0, 4.5], [4.5, 4]]);
  assert.equal(result.parts[0].notes[1].beat, 4.5); assert.equal(result.parts[1].notes[1].beat, 4.5);
  assert.equal(result.parts[0].notes[0].duration, 4.5); assert.equal(result.totalBeats, 8.5);
  assert.ok(result.warnings.some(w => w.includes('可能拉长原小节'))); assert.ok(result.warnings.some(w => w.includes('超过拍号')));
});

test('capability warnings disclose ignored notation and default tempo without guessing pitches', async () => {
  const xml = score(`<measure>${attrs}${shift('up')}<direction><direction-type><dynamics><pp/></dynamics><wedge type="crescendo"/></direction-type></direction>${note(12, '<notations><slur type="start"/><fermata/><ornaments><trill-mark/></ornaments><articulations><staccato/></articulations></notations>')}</measure>`);
  const result = await readScore(xml);
  for (const keyword of ['100 BPM', '八度移位线', '延长记号', '连奏线', '装饰记号', '渐强']) assert.ok(result.warnings.some(w => w.includes(keyword)), keyword);
  assert.equal(result.parts[0].notes[0].midi, 60); assert.equal(result.parts[0].notes[0].duration, 1);
  assert.equal(result.parts[0].notes[0].velocity, 36, 'later explicit pp falls back to its supported MIDI approximation');
  assert.ok(!result.warnings.some(w => w.includes('sound dynamics')), 'common pp no longer claims unsupported dynamics');
  assert.equal(PLAYBACK_CAPABILITY_SUMMARY, '基础音高与节奏；部分演奏记号尚未还原');
  const explicit = await readScore(score(`<measure>${attrs}<direction><direction-type><dynamics><pp/></dynamics></direction-type><sound dynamics="40" tempo="56"/></direction>${note(12)}</measure>`));
  assert.equal(explicit.parts[0].notes[0].velocity, 36); assert.ok(!explicit.warnings.some(w => w.includes('sound dynamics') || w.includes('100 BPM')));
});

test('source-defined part names and raw source IDs survive split staff display normalization', async () => {
  const xml = (name: string, instrument = '') => score(`<measure>${attrs.replace('</attributes>', '<staves>2</staves></attributes>')}${note(48, '<staff>1</staff>')}<backup><duration>48</duration></backup>${note(48, '<staff>2</staff>')}</measure>`, name).replace('</score-part>', `${instrument}</score-part>`);
  const generic = await readScore(xml('Voice'));
  assert.deepEqual(generic.parts.map(p => [p.id, p.sourcePartId, p.name]), [['P1-staff1', 'P1', '声部1 · 谱表 1'], ['P1-staff2', 'P1', '声部1 · 谱表 2']]);
  const named = await readScore(xml('Tenor')); assert.equal(named.parts[0].name, '男高音（Tenor） · 谱表 1');
  const piano = await readScore(xml('Piano')); assert.match(piano.parts[0].name, /右手/); assert.match(piano.parts[1].name, /左手/);
  const explicitInstrument = await readScore(xml('Keyboard', '<midi-instrument><midi-program>1</midi-program></midi-instrument>')); assert.match(explicitInstrument.parts[0].name, /右手/);
});

test('explicit correction removes only unclosed shift starts scoped by part/staff/number', async () => {
  const body = `<measure>${attrs}${shift('up', '1', '1', '<words>keep words</words>')}${shift('down', '2')}${shift('stop', '2')}${shift('up', '3', '2')}${shift('stop', '3', '1')}${note(48)}</measure>`;
  const xml = score(body);
  assert.equal(inspectOpenOctaveShifts(xml), 2);
  const updated = removeOpenOctaveShiftsXml(xml);
  assert.equal(inspectOpenOctaveShifts(updated), 0);
  const before = parsed(xml), after = parsed(updated);
  assert.equal(after.getElementsByTagName('octave-shift').length, 3, 'closed start/stop and unmatched stop retained');
  for (const tag of ['note', 'words', 'sound', 'direction', 'attributes']) assert.deepEqual(Array.from(after.getElementsByTagName(tag)).map(el => tag === 'direction' ? el.getElementsByTagName('sound').length : el.toString()), Array.from(before.getElementsByTagName(tag)).map(el => tag === 'direction' ? el.getElementsByTagName('sound').length : el.toString()));
  assert.deepEqual((await readScore(updated)).parts[0].notes, (await readScore(xml)).parts[0].notes);
  assert.equal(inspectOpenOctaveShifts(xml), 2, 'input string unchanged');
});

test('time signature correction updates one source measure across parts, preserving notes and future changes', async () => {
  const first = `<measure number="20">${attrs.replace('<beats>4</beats>', '<beats>5</beats>')}${note(48)}<backup><duration>48</duration></backup><note><rest/><duration>48</duration><voice>2</voice></note></measure>`;
  const second = `<measure number="21">${note(12)}</measure>`;
  const third = `<measure number="22"><attributes><time><beats>3</beats><beat-type>4</beat-type></time></attributes>${note(12)}</measure>`;
  const xml = score(first + second + third).replace('</score-partwise>', `<part id="P2">${first + second + third}</part></score-partwise>`);
  const updated = updateTimeSignatureXml(xml, 6, 2, { measure: 1 });
  const before = parsed(xml), after = parsed(updated);
  assert.deepEqual(Array.from(after.getElementsByTagName('time')).map(t => t.textContent), ['62', '34', '62', '34']);
  for (const tag of ['note', 'backup', 'duration', 'divisions', 'voice']) assert.deepEqual(Array.from(after.getElementsByTagName(tag)).map(el => el.toString()), Array.from(before.getElementsByTagName(tag)).map(el => el.toString()));
  const originalScore = await readScore(xml), corrected = await readScore(updated);
  assert.deepEqual(corrected.measures.map(m => [m.startBeat, m.duration]), [[0, 12], [12, 12], [24, 3]]);
  assert.equal(originalScore.parts[0].notes[1].beat, 5); assert.equal(corrected.parts[0].notes[1].beat, 12);
  assert.deepEqual(corrected.parts.map(p => p.notes.map(({ beat: _beat, ...data }) => data)), originalScore.parts.map(p => p.notes.map(({ beat: _beat, ...data }) => data)));
  const sourceOnly = parsed(updateTimeSignatureXml(xml, 6, 2, { measure: 1, sourcePartIds: ['P2'] }));
  assert.equal(sourceOnly.getElementsByTagName('time')[0].textContent, '54');
  assert.equal(sourceOnly.getElementsByTagName('time')[2].textContent, '62');
  const inserted = parsed(updateTimeSignatureXml(score(`<measure>${note(12)}</measure><measure>${note(12)}</measure>`), 6, 2, { measure: 2 }));
  assert.equal(inserted.getElementsByTagName('measure')[0].getElementsByTagName('time').length, 0);
  assert.equal(inserted.getElementsByTagName('measure')[1].firstChild?.nodeName, 'attributes');
});

test('time signature correction rejects invalid scopes and complex or midmeasure meter safely', () => {
  const xml = score(`<measure>${attrs}${note(12)}</measure>`);
  for (const [beats, type] of [[0, 2], [33, 2], [1.5, 2], [6, 3], [NaN, 4], [6, Infinity]]) assert.throws(() => updateTimeSignatureXml(xml, beats, type, { measure: 1 }), /拍号/);
  for (const options of [undefined, { measure: 0 }, { measure: 1.5 }, { measure: 2 }, { measure: 1, sourcePartIds: [] }, { measure: 1, sourcePartIds: ['missing'] }, { measure: 1, sourcePartIds: ['P1', 'P1'] }]) assert.throws(() => updateTimeSignatureXml(xml, 6, 2, options as { measure: number }));
  const composite = xml.replace('<beats>4</beats>', '<beats>3</beats><beat-type>8</beat-type><beats>2</beats>');
  assert.throws(() => updateTimeSignatureXml(composite, 6, 2, { measure: 1 }), /复合/);
  assert.throws(() => updateTimeSignatureXml(xml.replace('<time>', '<time number="1">'), 6, 2, { measure: 1 }), /分谱表/);
  assert.throws(() => updateTimeSignatureXml(score(`<measure>${note(12)}${attrs}</measure>`), 6, 2, { measure: 1 }), /中途/);
});

test('closed shifts in another part cannot close an unrelated open line; safe no-op and XML validation', () => {
  const xml = score(`<measure>${shift('up')}</measure>`).replace('</score-partwise>', `<part id="P2"><measure>${shift('stop')}</measure></part></score-partwise>`);
  assert.equal(inspectOpenOctaveShifts(xml), 1);
  const closed = score(`<measure>${shift('up')}${shift('stop')}</measure>`);
  assert.equal(removeOpenOctaveShiftsXml(closed), closed);
  for (const input of ['', '<score-partwise><part></score-partwise>', '<!DOCTYPE a [<!ENTITY x "a">]><score-partwise/>', '<score-partwise xmlns="http://evil.test"/>']) assert.throws(() => removeOpenOctaveShiftsXml(input));
});
