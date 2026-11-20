import test from 'node:test';
import assert from 'node:assert/strict';
import type { Score } from '../../src/music/types';
import { getPlaybackScore, playbackToSource, sourceToPlayback } from '../../src/music/playback';

const source: Score = {
  title: '',
  composer: '',
  tempo: 100,
  beatsPerMeasure: 4,
  xml: '',
  warnings: [],
  totalBeats: 16,
  measures: [0, 4, 8, 12].map((startBeat, i) => ({ number: i + 1, startBeat, duration: 4 })),
  parts: [],
  playback: {
    segments: [
      { sourceStart: 0, sourceEnd: 12, playStart: 0 },
      { sourceStart: 4, sourceEnd: 16, playStart: 12 },
    ],
    totalBeats: 24,
    expanded: true,
  },
};

test('mapping boundaries select the next passage while source seek selects the first occurrence', () => {
  assert.equal(playbackToSource(source, 11.99), 11.99);
  assert.equal(playbackToSource(source, 12), 4);
  assert.equal(playbackToSource(source, 20), 12);
  assert.equal(playbackToSource(source, 24), 16);
  assert.equal(sourceToPlayback(source, 4), 4);
  assert.equal(sourceToPlayback(source, 12), 20);
  assert.equal(sourceToPlayback(source, 16), 24);
  const snapshot = JSON.stringify(source);
  getPlaybackScore(source);
  assert.equal(JSON.stringify(source), snapshot);
});
