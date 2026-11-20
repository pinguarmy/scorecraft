import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { readScore, updateNoteXml, exportMidi } from '../../src/music/index';

const attrs = '<attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>';
const n = (step: string, duration: number, ties = '', extra = '', voice = '1', staff = '1') =>
  `<note>${extra}<pitch><step>${step}</step><octave>4</octave></pitch><duration>${duration}</duration><voice>${voice}</voice><staff>${staff}</staff>${ties}</note>`;
const tie = (type: string) => `<tie type="${type}"/>`;
const tied = (type: string) => `<notations><tied type="${type}"/></notations>`;
const wrap = (body: string) =>
  `<score-partwise><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${body}</part></score-partwise>`;
const measure = (body: string, first = false) => `<measure>${first ? attrs : ''}${body}</measure>`;
const chordBar = (ties: string, first = false) => measure(n('C', 16, ties) + n('E', 16, ties, '<chord/>'), first);
function midiNotes(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 14;
  const events: { tick: number; type: number; pitch: number }[] = [];
  const variable = () => {
    let value = 0,
      byte;
    do {
      byte = bytes[offset++];
      value = value * 128 + (byte & 127);
    } while (byte & 128);
    return value;
  };
  while (offset < bytes.length) {
    const end = offset + 8 + view.getUint32(offset + 4);
    offset += 8;
    let tick = 0;
    while (offset < end) {
      tick += variable();
      const status = bytes[offset++];
      if (status === 255) {
        offset++;
        const length = variable();
        offset += length;
      } else if ((status & 240) === 192) offset++;
      else {
        events.push({ tick, type: status & 240, pitch: bytes[offset] });
        offset += 2;
      }
    }
  }
  return events;
}

test('editing either end of a tied chord changes the whole selected pitch chain, preserving eight-beat MIDI sustain', async () => {
  const original = await readScore(wrap(chordBar(tie('start'), true) + chordBar(tie('stop'))));
  for (const selected of ['p0-m0-n0', 'p0-m1-n0']) {
    const xml = updateNoteXml(original.xml, selected, 62);
    const corrected = await readScore(xml);
    assert.deepEqual(
      corrected.parts[0].notes.map((note) => [note.midi, note.beat, note.duration]),
      [
        [62, 0, 8],
        [64, 0, 8],
      ],
    );
    assert.deepEqual(midiNotes(exportMidi(corrected)), [
      { tick: 0, type: 144, pitch: 62 },
      { tick: 0, type: 144, pitch: 64 },
      { tick: 3840, type: 128, pitch: 62 },
      { tick: 3840, type: 128, pitch: 64 },
    ]);
    const notes = Array.from(new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagName('note'));
    assert.deepEqual(
      notes.map((note) => note.getElementsByTagName('step')[0].textContent),
      ['D', 'E', 'D', 'E'],
    );
    assert.equal(corrected.totalBeats, 8);
    assert.deepEqual(
      corrected.warnings.filter((warning) => /延音线/.test(warning)),
      [],
    );
  }
  assert.deepEqual(
    original.parts[0].notes.map((note) => [note.midi, note.duration]),
    [
      [60, 8],
      [64, 8],
    ],
  );
});

test('three-measure notation-only tied chords correct from the middle without touching a separate same-pitch chain', async () => {
  const xml = wrap(
    chordBar(tied('start'), true) +
      chordBar('<notations><tied type="stop"/><tied type="start"/></notations>') +
      chordBar(tied('stop')) +
      chordBar(tie('start')) +
      chordBar(tie('stop')),
  );
  const original = await readScore(xml);
  const corrected = await readScore(updateNoteXml(original.xml, 'p0-m1-n0', 62));
  assert.deepEqual(
    corrected.parts[0].notes.map((note) => [note.midi, note.beat, note.duration]),
    [
      [62, 0, 12],
      [64, 0, 12],
      [60, 12, 8],
      [64, 12, 8],
    ],
  );
});

test('real rests and forward gaps break a same-pitch tie chain, and an overfull other part also prevents bridging', async () => {
  const first = measure(
    n('C', 4, tie('start')) + '<note><rest/><duration>12</duration><voice>1</voice><staff>1</staff></note>',
    true,
  );
  const original = await readScore(wrap(first + measure(n('C', 16, tie('stop')))));
  assert.deepEqual(
    (await readScore(updateNoteXml(original.xml, 'p0-m0-n0', 62))).parts[0].notes.map((note) => note.midi),
    [62, 60],
  );
  const forward = await readScore(
    wrap(measure(n('C', 4, tie('start')) + '<forward><duration>4</duration></forward>' + n('C', 8, tie('stop')), true)),
  );
  assert.deepEqual(
    (await readScore(updateNoteXml(forward.xml, 'p0-m0-n0', 62))).parts[0].notes.map((note) => note.midi),
    [62, 60],
  );
  const twoParts = wrap(chordBar(tie('start'), true) + chordBar(tie('stop'))).replace(
    '</score-partwise>',
    `<part id="P2">${measure(n('G', 20), true)}${measure(n('G', 16))}</part></score-partwise>`,
  );
  const aligned = await readScore(twoParts);
  const corrected = await readScore(updateNoteXml(aligned.xml, 'p0-m0-n0', 62));
  assert.deepEqual(
    corrected.parts[0].notes.map((note) => [note.midi, note.beat, note.duration]),
    [
      [62, 0, 4],
      [64, 0, 4],
      [60, 5, 4],
      [64, 5, 4],
    ],
  );
});

test('backup voices, staff and changing divisions keep independent tied chains separate', async () => {
  const body = (ties: string) =>
    n('C', 16, ties) +
    n('E', 16, ties, '<chord/>') +
    '<backup><duration>16</duration></backup>' +
    n('C', 16, ties, '', '2') +
    '<backup><duration>16</duration></backup>' +
    n('C', 16, ties, '', '1', '2');
  const xml = wrap(
    measure(body(tie('start')), true) +
      measure(
        '<attributes><divisions>8</divisions></attributes>' +
          body(tie('stop')).replaceAll('<duration>16</duration>', '<duration>32</duration>'),
      ),
  );
  const original = await readScore(xml);
  const corrected = await readScore(updateNoteXml(original.xml, 'p0-m1-n0', 62));
  assert.deepEqual(
    corrected.parts[0].notes.map((note) => [note.midi, note.duration]),
    [
      [62, 8],
      [64, 8],
      [60, 8],
      [60, 8],
    ],
  );
});

test('single-note ties and untied same-pitch notes retain the existing correction behavior', async () => {
  const original = await readScore(
    wrap(measure(n('C', 16, tie('start')), true) + measure(n('C', 16, tie('stop'))) + measure(n('C', 16))),
  );
  const corrected = await readScore(updateNoteXml(original.xml, 'p0-m1-n0', 61));
  assert.deepEqual(
    corrected.parts[0].notes.map((note) => [note.midi, note.duration]),
    [
      [61, 8],
      [60, 4],
    ],
  );
});

test('cue note participates in cursor calculation in updateNoteXml, preserving tied note positions and timing', async () => {
  const cueTiedXml = wrap(
    `<measure number="1">${attrs}<note><cue/><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note>${n('C', 12, tie('start'))}</measure><measure number="2">${attrs}${n('C', 12, tie('stop'))}<note><cue/><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice><staff>1</staff></note></measure>`,
  );
  const score = await readScore(cueTiedXml);
  assert.equal(score.parts[0].notes.length, 1);
  assert.equal(score.parts[0].notes[0].beat, 1);
  assert.equal(score.parts[0].notes[0].duration, 6);
  const corrected = await readScore(updateNoteXml(score.xml, 'p0-m0-n1', 62));
  assert.equal(corrected.parts[0].notes.length, 1);
  assert.equal(corrected.parts[0].notes[0].midi, 62);
  assert.equal(corrected.parts[0].notes[0].beat, 1);
  assert.equal(corrected.parts[0].notes[0].duration, 6);
});
