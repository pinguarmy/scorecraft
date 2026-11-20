import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeSession,
  saveDocuments,
  loadDocuments,
  upsertDocument,
  SESSION_KEY,
  LEGACY_RECENT_KEY,
  LEGACY_SETTINGS_KEY,
  type PracticeSession,
  type RecentDocument,
  type StorageLike,
} from '../../src/practice/session';

const bounds = { tempo: 100, totalBeats: 64, measureCount: 16, partIds: ['right', 'left'] };
class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}
function document(hex: string, preferences: Partial<PracticeSession> = {}): RecentDocument {
  return {
    id: `sha256:${hex.repeat(64)}`,
    title: 'Same title',
    composer: 'Composer',
    source: `${hex}.musicxml`,
    xml: `<score-partwise source="${hex}">  original XML  </score-partwise>`,
    opened: 123,
    session: sanitizeSession(
      {
        tempo: 132,
        transpose: -2,
        muted: ['left'],
        solo: 'right',
        loop: true,
        loopStart: 2,
        loopEnd: 5,
        position: 9.5,
        countIn: true,
        metronome: true,
        followRepeats: false,
        partInstruments: { right: 'guitar-acoustic', left: 'bass-electric' },
        ...preferences,
      },
      bounds,
    ),
  };
}

test('old typed sessions and stored v2 sessions receive scroll/enabled defaults without changing the v2 key', async () => {
  const oldTyped: PracticeSession = {
    tempo: 88,
    transpose: 0,
    metronome: false,
    muted: [],
    solo: null,
    loop: false,
    loopStart: 1,
    loopEnd: 1,
    position: 0,
    followRepeats: true,
    countIn: false,
  };
  const normalized = sanitizeSession(oldTyped, bounds);
  assert.equal(normalized.followMode, 'scroll');
  assert.equal(normalized.followEnabled, true);
  assert.equal('followMode' in oldTyped, false);
  assert.equal('followEnabled' in oldTyped, false);
  const old = document('a');
  delete old.session.followMode;
  delete old.session.followEnabled;
  const storage = new MemoryStorage();
  storage.setItem(SESSION_KEY, JSON.stringify([old]));
  const [loaded] = await loadDocuments(storage);
  assert.equal(SESSION_KEY, 'scorecraft.documents.v2');
  assert.equal(loaded.session.followMode, 'scroll');
  assert.equal(loaded.session.followEnabled, true);
  assert.equal(loaded.xml, old.xml);
  assert.equal(loaded.session.position, old.session.position);
});

test('v1 migration supplies follow defaults and preserves legacy storage and music', async () => {
  const storage = new MemoryStorage();
  const recent = JSON.stringify([{ title: 'Legacy', xml: '<score-partwise legacy="yes"/>', source: 'legacy.xml' }]);
  const settings = JSON.stringify({ tempo: 120, transpose: 2, metronome: true });
  storage.setItem(LEGACY_RECENT_KEY, recent);
  storage.setItem(LEGACY_SETTINGS_KEY, settings);
  const [migrated] = await loadDocuments(storage);
  assert.equal(migrated.session.followMode, 'scroll');
  assert.equal(migrated.session.followEnabled, true);
  assert.equal(migrated.xml, '<score-partwise legacy="yes"/>');
  assert.equal(migrated.session.tempo, 120);
  assert.equal(storage.getItem(LEGACY_RECENT_KEY), recent);
  assert.equal(storage.getItem(LEGACY_SETTINGS_KEY), settings);
  const [reloaded] = await loadDocuments(storage);
  assert.deepEqual(reloaded, migrated);
});

test('only exact page and boolean false override the view defaults', () => {
  for (const mode of [undefined, null, false, true, 0, 1, {}, [], ['page'], 'PAGE', ' page ', 'vertical', 'scroll']) {
    assert.equal(sanitizeSession({ followMode: mode }, bounds).followMode, 'scroll');
  }
  for (const enabled of [undefined, null, 0, 1, '', 'false', 'true', {}, [], [false], true]) {
    assert.equal(sanitizeSession({ followEnabled: enabled }, bounds).followEnabled, true);
  }
  assert.equal(sanitizeSession({ followMode: 'page', followEnabled: false }, bounds).followMode, 'page');
  assert.equal(sanitizeSession({ followMode: 'page', followEnabled: false }, bounds).followEnabled, false);
});

test('both view fields round-trip independently per document while preserving original XML and practice state', async () => {
  const storage = new MemoryStorage();
  const a = document('a', { followMode: 'page', followEnabled: false });
  const b = document('b', { followMode: 'scroll', followEnabled: true });
  const originalA = structuredClone(a);
  const originalB = structuredClone(b);
  assert.equal(saveDocuments(storage, [a, b]), true);
  const restored = await loadDocuments(storage);
  assert.deepEqual(restored, [originalA, originalB]);
  assert.notEqual(restored[0].session, a.session);
  assert.notEqual(restored[0].session.muted, a.session.muted);
  a.session.followMode = 'scroll';
  a.session.followEnabled = true;
  a.session.muted.push('right');
  assert.equal(restored[0].session.followMode, 'page');
  assert.equal(restored[0].session.followEnabled, false);
  assert.deepEqual(restored[0].session.muted, ['left']);
  assert.deepEqual(restored[1], originalB);
  const rebound = sanitizeSession(restored[0].session, { ...bounds, partIds: ['right'] });
  assert.equal(rebound.followMode, 'page');
  assert.equal(rebound.followEnabled, false);
  assert.equal(rebound.position, 9.5);
  assert.equal(rebound.loop, true);
  assert.equal(rebound.countIn, true);
  assert.deepEqual(rebound.partInstruments, { right: 'guitar-acoustic' });
  assert.equal(restored[0].xml, originalA.xml);
});

test('upsert preserves follow preferences on corrected music without altering another document or its source state', () => {
  const a = document('a', { followMode: 'page', followEnabled: false });
  const b = document('b');
  const snapshot = structuredClone([a, b]);
  const corrected = { ...a, xml: '<score-partwise corrected="yes"/>', title: 'Corrected' };
  const [updated, untouched] = upsertDocument([a, b], corrected);
  assert.equal(updated.id, a.id);
  assert.equal(updated.session.followMode, 'page');
  assert.equal(updated.session.followEnabled, false);
  assert.equal(updated.xml, corrected.xml);
  assert.deepEqual(updated.session, a.session);
  assert.notEqual(updated.session, a.session);
  assert.deepEqual(untouched, snapshot[1]);
  assert.deepEqual([a, b], snapshot);
});
