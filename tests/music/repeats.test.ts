import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from '@xmldom/xmldom';
import { buildRepeatPlayback } from '../../src/music/repeats';
import type { ScoreMeasure } from '../../src/music/types';

const forward = '<barline location="left"><repeat direction="forward"/></barline>';
const backward = (times?: string, location = 'right') =>
  `<barline location="${location}"><repeat direction="backward"${times === undefined ? '' : ` times="${times}"`}/></barline>`;
function run(contents: string[], otherParts: string[][] = []) {
  const part = (items: string[], index: number) =>
    `<part id="P${index}">${items.map((body, i) => `<measure number="${i + 1}">${body}</measure>`).join('')}</part>`;
  const root = new DOMParser().parseFromString(
    `<score-partwise>${[contents, ...otherParts].map(part).join('')}</score-partwise>`,
    'application/xml',
  ).documentElement;
  const measures: ScoreMeasure[] = contents.map((_, i) => ({ number: i + 1, startBeat: i * 4, duration: 4 }));
  return buildRepeatPlayback(root, measures, contents.length * 4);
}
const path = (result: ReturnType<typeof run>) => result.playback.segments.map((s) => s.sourceStart / 4 + 1);

test('implicit measure-one start and explicit adjacent ordinary repeats expand with exact times', () => {
  assert.deepEqual(path(run(['', backward()])), [1, 2, 1, 2]);
  assert.deepEqual(path(run([forward, backward('3'), forward, backward('2')])), [1, 2, 1, 2, 1, 2, 3, 4, 3, 4]);
  const eight = run([forward + backward('8')]);
  assert.equal(eight.playback.totalBeats, 32);
  assert.equal(eight.warnings.length, 0);
});

test('multiple parts must agree exactly about written repeat topology', () => {
  const agreed = run([forward, backward()], [[forward, backward()]]);
  assert.equal(agreed.playback.expanded, true);
  for (const other of [
    ['', ''],
    [forward, backward('3')],
  ]) {
    const conflict = run([forward, backward()], [other]);
    assert.equal(conflict.playback.expanded, false);
    assert.match(conflict.warnings[0], /声部/);
  }
});

test('nested, unmatched, ambiguous, unsupported location/times and advanced forms safely fall back', () => {
  const examples = [
    [forward, forward, backward(), backward()],
    [forward, ''],
    [backward(), backward()],
    ['<barline><repeat direction="forward"/></barline>', backward()],
    [backward(undefined, 'left')],
    [backward('0')],
    [backward('9')],
    [backward('2.5')],
    [backward('NaN')],
    ['<barline><repeat direction="sideways"/></barline>'],
    ['<repeat direction="backward"/>'],
    ['<barline><ending type="start" number="1"/></barline>'],
    ['<direction><direction-type><segno/></direction-type></direction>'],
    ['<direction><direction-type><coda/></direction-type></direction>'],
    ['<direction><direction-type><words>D.C. al Fine</words></direction-type></direction>'],
    ['<direction><sound dalsegno="segno"/></direction>'],
  ];
  for (const example of examples) {
    const result = run(example);
    assert.equal(result.playback.expanded, false, example.join(''));
    assert.equal(result.playback.totalBeats, example.length * 4);
    assert.ok(result.warnings.length > 0);
  }
});

test('segment count is bounded without truncated playback and straight scores stay compact', () => {
  const content = Array.from({ length: 1251 }, (_, i) => (i === 0 ? forward : i === 1250 ? backward('8') : ''));
  const result = run(content);
  assert.equal(result.playback.expanded, false);
  assert.match(result.warnings[0], /10000/);
  assert.equal(result.playback.totalBeats, 5004);
  const straight = run(Array(10001).fill(''));
  assert.equal(straight.playback.expanded, false);
  assert.equal(straight.playback.segments.length, 1);
  assert.equal(straight.warnings.length, 0);
});
