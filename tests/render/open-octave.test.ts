import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWithOsmd } from './harness';

// Newly authored CC0 structural fixture. No private score pitches, text or measures.
const fixture = (closed: boolean) => `<?xml version="1.0"?><score-partwise version="4.0"><work><work-title>Open line study</work-title></work><part-list><score-part id="P1"><part-name>Test piano</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><direction><direction-type><octave-shift type="up" size="15" number="1"/></direction-type></direction><note id="test-n0"><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure><measure number="2"><note id="test-n1"><pitch><step>E</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>${closed ? '<direction><direction-type><octave-shift type="stop" size="15" number="1"/></direction-type></direction>' : ''}</measure></part></score-partwise>`;

test('actual OSMD crashes on open ottava, display-model endpoint repair preserves musical data and renders', async () => {
  const red = await renderWithOsmd(fixture(false), false);
  assert.equal(red.result.ok, false);
  if (red.result.ok) throw new Error('Expected pre-fix renderer failure');
  assert.match(red.result.message || '', /realValue/);
  assert.match(red.result.stack || '', /calculateSingleOctaveShift/);
  const green = await renderWithOsmd(fixture(false), true);
  assert.equal(green.result.ok, true);
  if (!green.result.ok) throw new Error(green.result.stack);
  assert.equal(green.result.measures, 2);
  assert.equal(green.result.parts, 1);
  assert.equal(green.result.inputNotes, 2);
  assert.equal(green.result.unchanged, true);
  assert.equal(green.result.compatibility.repairedOctaveShifts, 1);
  assert.equal(green.result.compatibility.warnings.length, 1);
  assert.equal(green.result.svgs, 1);
});

test('properly closed ottava remains untouched and renders without compatibility warning', async () => {
  const output = await renderWithOsmd(fixture(true), true);
  assert.equal(output.result.ok, true);
  if (!output.result.ok) throw new Error(output.result.stack);
  assert.equal(output.result.unchanged, true);
  assert.equal(output.result.compatibility.repairedOctaveShifts, 0);
  assert.deepEqual(output.result.compatibility.warnings, []);
});
