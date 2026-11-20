import test from 'node:test';
import assert from 'node:assert/strict';
import { readScore } from '../../src/music/index';

const tabAttributes =
  '<attributes><divisions>1</divisions><clef><sign>TAB</sign><line>5</line></clef><staff-details><staff-type>tablature</staff-type><staff-lines>6</staff-lines><staff-tuning line="1"><tuning-step>E</tuning-step><tuning-octave>4</tuning-octave></staff-tuning></staff-details></attributes>';
const technical =
  '<notations><technical><string>1</string><fret>3</fret><bend><bend-alter>2</bend-alter></bend><hammer-on type="start">H</hammer-on></technical><slide type="start"/></notations>';
const wrap = (body: string, definitions = '') =>
  `<score-partwise><part-list><score-part id="P1"><part-name>Guitar</part-name>${definitions}</score-part></part-list><part id="P1"><measure number="1">${body}</measure></part></score-partwise>`;

test('authored TAB with explicit pitch plays normal source notes and discloses techniques only', async () => {
  const xml = wrap(
    `${tabAttributes}<note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration>${technical}</note>`,
  );
  const score = await readScore(xml);
  assert.deepEqual(
    score.parts[0].notes.map((note) => [note.midi, note.beat, note.duration]),
    [[67, 0, 1]],
  );
  assert.ok(score.warnings.some((warning) => warning.includes('吉他技巧')));
  assert.ok(!score.warnings.some((warning) => warning.includes('未提供明确音高')));
  assert.match(score.xml, /<fret>3<\/fret>/);
  assert.match(score.xml, /<bend-alter>2<\/bend-alter>/);
});

test('authored position-only TAB skips missing pitches with explicit warning, never infers tuning', async () => {
  const xml = wrap(
    `${tabAttributes}<note><duration>1</duration><notations><technical><string>1</string><fret>3</fret></technical></notations></note><note><rest/><duration>3</duration></note>`,
  );
  const score = await readScore(xml);
  assert.equal(score.parts[0].notes.length, 0);
  assert.equal(score.totalBeats, 4);
  assert.ok(score.warnings.some((warning) => warning.includes('六线谱') && warning.includes('不会根据调弦推测')));
  assert.match(score.xml, /<staff-tuning/);
  assert.match(score.xml, /<fret>3<\/fret>/);
});

test('authored GM percussion import retains explicit drum mapping without TAB false warning', async () => {
  const xml = wrap(
    '<attributes><divisions>1</divisions><clef><sign>percussion</sign></clef></attributes><note><instrument id="kick"/><unpitched><display-step>C</display-step><display-octave>5</display-octave></unpitched><duration>1</duration></note>',
    '<midi-instrument id="kick"><midi-unpitched>37</midi-unpitched></midi-instrument>',
  );
  const score = await readScore(xml);
  assert.deepEqual(
    score.parts[0].notes.map((note) => [note.midi, note.percussion, note.duration]),
    [[36, 36, 1]],
  );
  assert.ok(!score.warnings.some((warning) => warning.includes('六线谱') || warning.includes('吉他技巧')));
});
