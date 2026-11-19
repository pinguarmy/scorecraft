import test from 'node:test';
import assert from 'node:assert/strict';
import { readScore } from '../../src/music/index';

function pulseScore(withLayoutBreaks: boolean): string {
  return `<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">${Array.from({ length: 8 }, (_, index) => `<measure number="${index + 1}">${index === 0 ? '<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>' : ''}${withLayoutBreaks && index > 0 && index % 2 === 0 ? `<print ${index === 4 ? 'new-page' : 'new-system'}="yes"/>` : ''}${Array.from({ length: 4 }, () => '<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>').join('')}</measure>`).join('')}</part></score-partwise>`;
}

test('system and page breaks never add music-time gaps to an authored fixed pulse', async () => {
  const plain = await readScore(pulseScore(false));
  const broken = await readScore(pulseScore(true));
  assert.deepEqual(broken.measures, plain.measures);
  assert.deepEqual(broken.parts[0].notes.map(({ beat, duration }) => ({ beat, duration })), plain.parts[0].notes.map(({ beat, duration }) => ({ beat, duration })));
  assert.equal(broken.totalBeats, 32);
  const notes = broken.parts[0].notes;
  for (let index = 1; index < notes.length; index++) assert.equal(notes[index].beat, notes[index - 1].beat + notes[index - 1].duration);
});

test('an authored trailing rest remains encoded, distinct from a layout break', async () => {
  const xml = pulseScore(true).replace('<note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note></measure><measure number="3">', '<note><rest/><duration>1</duration><type>quarter</type></note></measure><measure number="3">');
  const score = await readScore(xml);
  const prior = score.parts[0].notes.filter(note => note.measure === 2).at(-1)!;
  const next = score.parts[0].notes.find(note => note.measure === 3)!;
  assert.equal(next.beat - prior.beat - prior.duration, 1);
  assert.equal(score.measures[1].duration, 4);
});
