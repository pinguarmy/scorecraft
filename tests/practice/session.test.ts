import test from 'node:test';
import assert from 'node:assert/strict';
import {
  documentId,
  loadDocuments,
  sanitizeSession,
  saveDocuments,
  upsertDocument,
  SESSION_KEY,
  LEGACY_RECENT_KEY,
  LEGACY_SETTINGS_KEY,
  MAX_DOCUMENTS,
  MAX_XML_CHARS,
  type PracticeSession,
  type RecentDocument,
  type SessionBounds,
  type StorageLike,
} from '../../src/practice/session';

class MemoryStorage implements StorageLike {
  private map = new Map<string, string>();
  failOnSet = false;

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    if (this.failOnSet) {
      throw new Error('QuotaExceededError');
    }
    this.map.set(key, value);
  }
}

const SHA_1 = 'sha256:' + '1'.repeat(64);
const SHA_2 = 'sha256:' + '2'.repeat(64);
const SHA_3 = 'sha256:' + '3'.repeat(64);
const SHA_4 = 'sha256:' + '4'.repeat(64);
const SHA_5 = 'sha256:' + '5'.repeat(64);

test('documentId computes stable SHA256 of normalized XML', async () => {
  const xml1 = '<?xml version="1.0"?>\r\n<score-partwise>\r\n  <part id="P1"/>\r\n</score-partwise>\r\n';
  const xml2 = '\uFEFF<?xml version="1.0"?>\n<score-partwise>\n  <part id="P1"/>\n</score-partwise>';

  const id1 = await documentId(xml1);
  const id2 = await documentId(xml2);

  assert.ok(id1.startsWith('sha256:'));
  assert.equal(id1.length, 7 + 64);
  assert.equal(id1, id2, 'CRLF, BOM, and outer whitespace differences must produce the identical document ID');
});

test('documentId keeps valid explicit job:<uuid> and sha256:<64hex>', async () => {
  const uuid = '12345678-1234-1234-1234-123456789abc';
  const explicitJob = `job:${uuid}`;
  const sha = 'sha256:' + 'a'.repeat(64);

  const resJob = await documentId('<xml/>', explicitJob);
  const resSha = await documentId('<xml/>', sha);

  assert.equal(resJob, explicitJob);
  assert.equal(resSha, sha);

  // Invalid explicit IDs should fallback to computed sha256
  const fallbackRes = await documentId('<xml/>', 'custom-title-based-id');
  assert.ok(fallbackRes.startsWith('sha256:'));
  assert.notEqual(fallbackRes, 'custom-title-based-id');
});

test('same title and composer but distinct XML yield distinct IDs without collision', async () => {
  const xmlA = '<score-partwise><work><work-title>Test</work-title></work><measure number="1"/></score-partwise>';
  const xmlB = '<score-partwise><work><work-title>Test</work-title></work><measure number="2"/></score-partwise>';

  const idA = await documentId(xmlA);
  const idB = await documentId(xmlB);

  assert.notEqual(idA, idB, 'Different XML contents must not collide even if titles match');

  const baseSession: PracticeSession = {
    tempo: 120,
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

  const docA: RecentDocument = { id: idA, title: 'Test', composer: 'Anon', xml: xmlA, opened: 100, source: 'a.xml', session: baseSession };
  const docB: RecentDocument = { id: idB, title: 'Test', composer: 'Anon', xml: xmlB, opened: 200, source: 'b.xml', session: baseSession };

  const list = upsertDocument([docA], docB);
  assert.equal(list.length, 2, 'Distinct XML with identical title/composer must both be preserved');
  assert.equal(list[0].id, idB);
  assert.equal(list[1].id, idA);
});

test('sanitizeSession clamps tempo, bounds loop range, clamps position, and strictly checks booleans', () => {
  const bounds: SessionBounds = {
    tempo: 100,
    totalBeats: 16,
    measureCount: 8,
    partIds: ['P1', 'P2'],
  };

  const dirty = {
    tempo: 999,
    transpose: -20,
    metronome: 1, // truthy non-boolean must be rejected to false
    muted: ['P1', 'UNKNOWN', 'P1', 123],
    solo: 'INVALID',
    loop: 'true', // string truthy non-boolean must be rejected to false
    loopStart: 10,
    loopEnd: 2,
    position: 999,
    followRepeats: false,
  };

  const clean = sanitizeSession(dirty, bounds);

  assert.equal(clean.tempo, 240, 'tempo clamped to 240');
  assert.equal(clean.transpose, -12, 'transpose clamped to -12');
  assert.equal(clean.metronome, false, 'metronome must strictly require true');
  assert.deepEqual(clean.muted, ['P1'], 'muted parts deduplicated and filtered to existing part IDs');
  assert.equal(clean.solo, null, 'unknown solo part cleared to null');
  assert.equal(clean.loop, false, 'loop must strictly require true');
  assert.equal(clean.loopStart, 8, 'loopStart clamped to measureCount (8)');
  assert.equal(clean.loopEnd, 8, 'loopEnd clamped and must be >= loopStart');
  assert.equal(clean.position, 16, 'position clamped to totalBeats (16)');
  assert.equal(clean.followRepeats, false);

  // Test true values and lower clamps
  const cleanValid = sanitizeSession({
    metronome: true,
    loop: true,
    tempo: 10,
    transpose: 30,
    loopStart: -5,
    loopEnd: -1,
    position: -10,
  }, bounds);

  assert.equal(cleanValid.metronome, true);
  assert.equal(cleanValid.loop, true);
  assert.equal(cleanValid.tempo, 30);
  assert.equal(cleanValid.transpose, 12);
  assert.equal(cleanValid.loopStart, 1);
  assert.equal(cleanValid.loopEnd, 1);
  assert.equal(cleanValid.position, 0);
  assert.equal(cleanValid.followRepeats, true, 'followRepeats defaults to true');
});

test('upsertDocument replaces existing record by stable ID, moves to newest, and enforces MAX_DOCUMENTS limit', () => {
  const baseSession: PracticeSession = {
    tempo: 120,
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

  const doc1: RecentDocument = { id: SHA_1, title: 'Doc 1', composer: '', xml: '<doc1/>', opened: 100, source: 's1', session: baseSession };
  const doc2: RecentDocument = { id: SHA_2, title: 'Doc 2', composer: '', xml: '<doc2/>', opened: 200, source: 's2', session: baseSession };
  const doc3: RecentDocument = { id: SHA_3, title: 'Doc 3', composer: '', xml: '<doc3/>', opened: 300, source: 's3', session: baseSession };
  const doc4: RecentDocument = { id: SHA_4, title: 'Doc 4', composer: '', xml: '<doc4/>', opened: 400, source: 's4', session: baseSession };

  let docs = [doc3, doc2, doc1];

  // Upsert updated doc2 (stable ID correction/update)
  const updatedDoc2: RecentDocument = { ...doc2, title: 'Doc 2 Revised', opened: 500 };
  docs = upsertDocument(docs, updatedDoc2);

  assert.equal(docs.length, 3);
  assert.equal(docs[0].id, SHA_2);
  assert.equal(docs[0].title, 'Doc 2 Revised');
  assert.deepEqual(docs.map(d => d.id), [SHA_2, SHA_3, SHA_1]);

  // Add doc4 and doc5 (cap at MAX_DOCUMENTS = 4)
  docs = upsertDocument(docs, doc4);
  assert.equal(docs.length, 4);

  const doc5: RecentDocument = { id: SHA_5, title: 'Doc 5', composer: '', xml: '<doc5/>', opened: 600, source: 's5', session: baseSession };
  docs = upsertDocument(docs, doc5);
  assert.equal(docs.length, 4);
  assert.equal(docs[0].id, SHA_5);
  assert.ok(!docs.some(d => d.id === SHA_1), 'oldest document dropped when capped at 4');

  // Reject oversized XML without dropping others
  const oversizedDoc: RecentDocument = {
    id: 'sha256:' + 'e'.repeat(64),
    title: 'Huge',
    composer: '',
    xml: 'x'.repeat(MAX_XML_CHARS + 1),
    opened: 700,
    source: 's',
    session: baseSession,
  };
  const sameDocs = upsertDocument(docs, oversizedDoc);
  assert.equal(sameDocs.length, 4);
  assert.ok(!sameDocs.some(d => d.id === oversizedDoc.id));

  // Reject invalid title-based ID in upsertDocument
  const invalidIdDoc: RecentDocument = {
    id: 'Title:Composer',
    title: 'Invalid',
    composer: '',
    xml: '<xml/>',
    opened: 800,
    source: 's',
    session: baseSession,
  };
  const afterInvalid = upsertDocument(docs, invalidIdDoc);
  assert.equal(afterInvalid.length, 4);
  assert.ok(!afterInvalid.some(d => d.id === 'Title:Composer'));
});

test('saveDocuments handles storage failure gracefully and excludes non-schema properties like originalUrl', () => {
  const storage = new MemoryStorage();
  const session: PracticeSession = {
    tempo: 120,
    transpose: 0,
    metronome: false,
    countIn: false,
    muted: [],
    solo: null,
    loop: false,
    loopStart: 1,
    loopEnd: 1,
    position: 0,
    followRepeats: true,
  };
  const docWithExtra: RecentDocument & { originalUrl?: string } = {
    id: SHA_1,
    title: 'D',
    composer: '',
    xml: '<xml/>',
    opened: 1,
    source: '',
    session,
    originalUrl: 'http://example.com/leak',
  };

  assert.equal(saveDocuments(storage, [docWithExtra]), true);
  const raw = storage.getItem(SESSION_KEY);
  assert.ok(raw);
  const parsed = JSON.parse(raw);
  assert.equal(parsed[0].originalUrl, undefined, 'saveDocuments must strictly exclude external originalUrl');

  storage.failOnSet = true;
  assert.equal(saveDocuments(storage, [docWithExtra]), false, 'Must return false when quota is exceeded without throwing');
});

test('loadDocuments reads v2, sanitizes corrupt data, and rejects oversized strings', async () => {
  const storage = new MemoryStorage();
  storage.setItem(SESSION_KEY, JSON.stringify([
    {
      id: SHA_1,
      title: 'Valid Score',
      composer: 'Bach',
      xml: '<xml>good</xml>',
      opened: 12345,
      source: 'upload.xml',
      jobId: '12345678-1234-1234-1234-123456789abc',
      session: { tempo: 150, muted: ['p1'] },
      originalUrl: 'http://evil.com/leak',
    },
    {
      id: SHA_2,
      title: 'Oversized Score',
      xml: 'a'.repeat(MAX_XML_CHARS + 1),
      session: {},
    },
  ]));

  const loaded = await loadDocuments(storage);
  assert.equal(loaded.length, 1);
  const doc = loaded[0];
  assert.equal(doc.id, SHA_1);
  assert.equal(doc.title, 'Valid Score');
  assert.equal(doc.jobId, '12345678-1234-1234-1234-123456789abc');
  assert.equal((doc as Record<string, unknown>).originalUrl, undefined, 'no external URL persistence');
  assert.equal(doc.session.tempo, 150);
  assert.deepEqual(doc.session.muted, ['p1']);
});

test('loadDocuments respects explicit empty v2 array without resurrecting v1', async () => {
  const storage = new MemoryStorage();
  storage.setItem(SESSION_KEY, JSON.stringify([]));
  storage.setItem(LEGACY_RECENT_KEY, JSON.stringify([
    {
      id: 'legacy-id',
      title: 'Legacy',
      xml: '<legacy/>',
      opened: 10,
      source: 'legacy.xml',
    },
  ]));

  const loaded = await loadDocuments(storage);
  assert.deepEqual(loaded, [], 'Explicit [] in v2 must be respected and not resurrect v1');
});

test('loadDocuments falls back to v1 on malformed or non-array v2 JSON', async () => {
  const v1Xml = '<score-partwise><movement-title>Old Song</movement-title></score-partwise>';
  const expectedId = await documentId(v1Xml);

  // Case 1: Malformed JSON in v2
  const storageMalformed = new MemoryStorage();
  storageMalformed.setItem(SESSION_KEY, '{ invalid json');
  storageMalformed.setItem(LEGACY_RECENT_KEY, JSON.stringify([
    {
      id: 'Old Song:',
      title: 'Old Song',
      xml: v1Xml,
      opened: 1000,
      source: 'local.xml',
    },
  ]));

  const loaded1 = await loadDocuments(storageMalformed);
  assert.equal(loaded1.length, 1);
  assert.equal(loaded1[0].id, expectedId);

  // Case 2: Non-array in v2
  const storageNonArray = new MemoryStorage();
  storageNonArray.setItem(SESSION_KEY, JSON.stringify({ not: 'an array' }));
  storageNonArray.setItem(LEGACY_RECENT_KEY, JSON.stringify([
    {
      id: 'Old Song:',
      title: 'Old Song',
      xml: v1Xml,
      opened: 1000,
      source: 'local.xml',
    },
  ]));

  const loaded2 = await loadDocuments(storageNonArray);
  assert.equal(loaded2.length, 1);
  assert.equal(loaded2[0].id, expectedId);
});

test('loadDocuments migrates v1 recent and practice settings preserving originals and hashing once', async () => {
  const storage = new MemoryStorage();
  const v1Xml = '<score-partwise><movement-title>Old Song</movement-title></score-partwise>';
  storage.setItem(LEGACY_RECENT_KEY, JSON.stringify([
    {
      id: 'Old Song:',
      title: 'Old Song',
      xml: v1Xml,
      opened: 1000,
      source: 'local.xml',
      jobId: 'ABCDEF01-1234-1234-1234-123456789ABC',
    },
  ]));
  storage.setItem(LEGACY_SETTINGS_KEY, JSON.stringify({
    tempo: 132,
    transpose: -2,
    metronome: true,
  }));

  const loaded = await loadDocuments(storage);

  assert.equal(loaded.length, 1);
  const migrated = loaded[0];
  const expectedId = await documentId(v1Xml);
  assert.equal(migrated.id, expectedId, 'Legacy id replaced by computed SHA256');
  assert.equal(migrated.title, 'Old Song');
  assert.equal(migrated.composer, '');
  assert.equal(migrated.jobId, 'abcdef01-1234-1234-1234-123456789abc');
  assert.equal(migrated.session.tempo, 132);
  assert.equal(migrated.session.transpose, -2);
  assert.equal(migrated.session.metronome, true);
  assert.equal(migrated.session.countIn, false, 'Legacy migration must default countIn to false');

  // Verify v2 is saved, legacy keys are untouched
  assert.ok(storage.getItem(SESSION_KEY), 'v2 must be written on nonempty migration');
  assert.ok(storage.getItem(LEGACY_RECENT_KEY), 'legacy recent key must not be overwritten or deleted');
  assert.ok(storage.getItem(LEGACY_SETTINGS_KEY), 'legacy settings key must not be overwritten or deleted');
});

test('loadDocuments does not write empty migration or drop legacy on bad v1 JSON', async () => {
  const storage = new MemoryStorage();
  storage.setItem(LEGACY_RECENT_KEY, '{ invalid json');

  const loaded = await loadDocuments(storage);
  assert.deepEqual(loaded, []);
  assert.equal(storage.getItem(SESSION_KEY), null, 'Must not write v2 on corrupt v1 JSON');
  assert.equal(storage.getItem(LEGACY_RECENT_KEY), '{ invalid json', 'Must preserve legacy raw string');

  // Empty array in legacy
  const storageEmpty = new MemoryStorage();
  storageEmpty.setItem(LEGACY_RECENT_KEY, JSON.stringify([]));
  const loadedEmpty = await loadDocuments(storageEmpty);
  assert.deepEqual(loadedEmpty, []);
  assert.equal(storageEmpty.getItem(SESSION_KEY), null, 'Must not write empty migration to v2');
});
