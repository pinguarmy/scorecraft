import test from 'node:test';
import assert from 'node:assert/strict';
import { readScore, getPlaybackScore, exportMidi } from '../../src/music/index';

const scoreXml = (barline: string, direction = '') => `<score-partwise><part-list><score-part id="P1"><part-name>Test</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>${direction}<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration></note>${barline}</measure></part></score-partwise>`;

test('advanced repeat structures keep full source order and expose fallback warnings through readScore', async () => {
  for (const xml of [
    scoreXml('<barline location="right"><ending number="1" type="start"/><repeat direction="backward"/></barline>'),
    scoreXml('<barline location="middle"><repeat direction="backward"/></barline>'),
    scoreXml('<barline location="right"><repeat direction="backward" times="99"/></barline>'),
    scoreXml('<barline location="right"><repeat direction="backward"/></barline>', '<direction><sound dacapo="yes"/></direction>'),
    scoreXml('<barline location="left"><repeat direction="forward"/></barline>'),
  ]) {
    const score = await readScore(xml);
    assert.equal(score.playback?.expanded, false);
    assert.equal(score.totalBeats, 4); assert.equal(score.parts[0].notes.length, 1);
    assert.ok(score.warnings.length > 0, 'unsupported repeat is never silently flattened');
    assert.equal(getPlaybackScore(score), score);
    assert.deepEqual(exportMidi(score), exportMidi(score, { followRepeats: false }));
  }
});
