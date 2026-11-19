import test from 'node:test';
import assert from 'node:assert/strict';
import {
  loadDocuments,
  sanitizeSession,
  saveDocuments,
  SESSION_KEY,
  LEGACY_RECENT_KEY,
  LEGACY_SETTINGS_KEY,
  type PracticeSession,
  type RecentDocument,
  type SessionBounds,
  type StorageLike,
} from '../../src/practice/session';

class MemoryStorage implements StorageLike {
  private map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const bounds: SessionBounds = {
  tempo: 120,
  totalBeats: 32,
  measureCount: 8,
  partIds: ['P1', 'P2'],
};

test('sanitizeSession strictly checks countIn: missing, invalid/truthy types default to false, true remains true', () => {
  // Missing
  const missing = sanitizeSession({}, bounds);
  assert.strictEqual(missing.countIn, false, 'Missing countIn must default to false');

  // Null & undefined
  assert.strictEqual(sanitizeSession({ countIn: null }, bounds).countIn, false);
  assert.strictEqual(sanitizeSession({ countIn: undefined }, bounds).countIn, false);

  // Truthy / non-boolean values must NOT be coerced to true
  assert.strictEqual(sanitizeSession({ countIn: 1 }, bounds).countIn, false, 'Number 1 must default to false');
  assert.strictEqual(sanitizeSession({ countIn: 'true' }, bounds).countIn, false, 'String "true" must default to false');
  assert.strictEqual(sanitizeSession({ countIn: '1' }, bounds).countIn, false, 'String "1" must default to false');
  assert.strictEqual(sanitizeSession({ countIn: [] }, bounds).countIn, false, 'Array must default to false');
  assert.strictEqual(sanitizeSession({ countIn: {} }, bounds).countIn, false, 'Object must default to false');

  // Falsy non-boolean values
  assert.strictEqual(sanitizeSession({ countIn: 0 }, bounds).countIn, false);
  assert.strictEqual(sanitizeSession({ countIn: '' }, bounds).countIn, false);
  assert.strictEqual(sanitizeSession({ countIn: false }, bounds).countIn, false);

  // Explicit true
  const validTrue = sanitizeSession({ countIn: true }, bounds);
  assert.strictEqual(validTrue.countIn, true, 'Explicit boolean true must be preserved');
});

test('v2 save and load roundtrip per-document A/B countIn true/false with other fields unchanged', async () => {
  const storage = new MemoryStorage();

  const sessionA: PracticeSession = {
    tempo: 140,
    transpose: 3,
    metronome: true,
    muted: ['P1'],
    solo: 'P2',
    loop: true,
    loopStart: 2,
    loopEnd: 6,
    position: 8.5,
    followRepeats: false,
    countIn: true,
  };

  const sessionB: PracticeSession = {
    tempo: 96,
    transpose: -1,
    metronome: false,
    muted: [],
    solo: null,
    loop: false,
    loopStart: 1,
    loopEnd: 4,
    position: 0,
    followRepeats: true,
    countIn: false,
  };

  const docA: RecentDocument = {
    id: 'sha256:' + 'a'.repeat(64),
    title: 'Doc A',
    composer: 'Composer A',
    xml: '<score-partwise id="A"/>',
    opened: 1000,
    source: 'docA.xml',
    session: sessionA,
  };

  const docB: RecentDocument = {
    id: 'sha256:' + 'b'.repeat(64),
    title: 'Doc B',
    composer: 'Composer B',
    xml: '<score-partwise id="B"/>',
    opened: 2000,
    source: 'docB.xml',
    session: sessionB,
  };

  const saved = saveDocuments(storage, [docA, docB]);
  assert.strictEqual(saved, true);

  const loaded = await loadDocuments(storage);
  assert.strictEqual(loaded.length, 2);

  // Doc A assertions
  const loadedA = loaded.find(d => d.id === docA.id);
  assert.ok(loadedA);
  assert.strictEqual(loadedA.session.countIn, true);
  assert.strictEqual(loadedA.session.tempo, 140);
  assert.strictEqual(loadedA.session.transpose, 3);
  assert.strictEqual(loadedA.session.metronome, true);
  assert.deepEqual(loadedA.session.muted, ['P1']);
  assert.strictEqual(loadedA.session.solo, 'P2');
  assert.strictEqual(loadedA.session.loop, true);
  assert.strictEqual(loadedA.session.loopStart, 2);
  assert.strictEqual(loadedA.session.loopEnd, 6);
  assert.strictEqual(loadedA.session.position, 8.5);
  assert.strictEqual(loadedA.session.followRepeats, false);

  // Doc B assertions
  const loadedB = loaded.find(d => d.id === docB.id);
  assert.ok(loadedB);
  assert.strictEqual(loadedB.session.countIn, false);
  assert.strictEqual(loadedB.session.tempo, 96);
  assert.strictEqual(loadedB.session.transpose, -1);
  assert.strictEqual(loadedB.session.metronome, false);
  assert.deepEqual(loadedB.session.muted, []);
  assert.strictEqual(loadedB.session.solo, null);
  assert.strictEqual(loadedB.session.loop, false);
  assert.strictEqual(loadedB.session.loopStart, 1);
  assert.strictEqual(loadedB.session.loopEnd, 4);
  assert.strictEqual(loadedB.session.position, 0);
  assert.strictEqual(loadedB.session.followRepeats, true);
});

test('v2 old document missing countIn defaults to false without modifying other fields', async () => {
  const storage = new MemoryStorage();

  const legacyV2Doc = {
    id: 'sha256:' + 'c'.repeat(64),
    title: 'Doc C',
    composer: 'Composer C',
    xml: '<score-partwise id="C"/>',
    opened: 3000,
    source: 'docC.xml',
    session: {
      tempo: 110,
      transpose: 2,
      metronome: true,
      muted: ['P1'],
      solo: null,
      loop: true,
      loopStart: 1,
      loopEnd: 3,
      position: 4,
      followRepeats: true,
      // countIn is deliberately missing
    },
  };

  storage.setItem(SESSION_KEY, JSON.stringify([legacyV2Doc]));

  const loaded = await loadDocuments(storage);
  assert.strictEqual(loaded.length, 1);
  const doc = loaded[0];

  assert.strictEqual(doc.session.countIn, false, 'v2 missing countIn must default to false');
  assert.strictEqual(doc.session.tempo, 110);
  assert.strictEqual(doc.session.transpose, 2);
  assert.strictEqual(doc.session.metronome, true);
  assert.deepEqual(doc.session.muted, ['P1']);
  assert.strictEqual(doc.session.solo, null);
  assert.strictEqual(doc.session.loop, true);
  assert.strictEqual(doc.session.loopStart, 1);
  assert.strictEqual(doc.session.loopEnd, 3);
  assert.strictEqual(doc.session.position, 4);
  assert.strictEqual(doc.session.followRepeats, true);
});

test('legacy migration defaults countIn to false, and empty v2 array stays empty without resurrecting legacy', async () => {
  // Test legacy migration defaults countIn to false
  const storageMigration = new MemoryStorage();
  const legacyXml = '<score-partwise id="legacy"/>';
  storageMigration.setItem(LEGACY_RECENT_KEY, JSON.stringify([
    {
      id: 'Legacy Song',
      title: 'Legacy Song',
      xml: legacyXml,
      opened: 500,
      source: 'legacy.xml',
    },
  ]));
  storageMigration.setItem(LEGACY_SETTINGS_KEY, JSON.stringify({
    tempo: 104,
    transpose: 1,
    metronome: true,
  }));

  const migrated = await loadDocuments(storageMigration);
  assert.strictEqual(migrated.length, 1);
  assert.strictEqual(migrated[0].session.countIn, false, 'Legacy migrated session must have countIn: false');
  assert.strictEqual(migrated[0].session.tempo, 104);
  assert.strictEqual(migrated[0].session.transpose, 1);
  assert.strictEqual(migrated[0].session.metronome, true);

  // Test explicit empty array in v2 stays empty and never resurrects v1
  const storageCleared = new MemoryStorage();
  storageCleared.setItem(SESSION_KEY, JSON.stringify([]));
  storageCleared.setItem(LEGACY_RECENT_KEY, JSON.stringify([
    {
      id: 'Resurrect attempt',
      title: 'Resurrect attempt',
      xml: legacyXml,
      opened: 600,
      source: 'legacy.xml',
    },
  ]));

  const clearedLoaded = await loadDocuments(storageCleared);
  assert.deepEqual(clearedLoaded, [], 'Explicit empty v2 array must stay empty and not resurrect legacy v1 records');
});
