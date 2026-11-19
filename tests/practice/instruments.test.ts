import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSession, saveDocuments, loadDocuments, upsertDocument, SESSION_KEY, LEGACY_RECENT_KEY, type RecentDocument, type StorageLike } from '../../src/practice/session';

const bounds = { tempo: 100, totalBeats: 32, measureCount: 8, partIds: ['right', 'left', 'drums'] };
const ids = ['piano-bright', 'piano-warm', 'guitar-acoustic', 'guitar-electric', 'bass-electric', 'strings', 'synth-pad', 'drums'];
class MemoryStorage implements StorageLike {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}
function document(hex: string, partInstruments: Record<string, string>): RecentDocument {
  return { id: `sha256:${hex.repeat(64)}`, title: 'Same title', composer: '', source: 'input.musicxml', xml: `<score-partwise id="${hex}"/>`, opened: 1, session: sanitizeSession({ tempo: 140, muted: ['left'], solo: 'right', position: 7.5, countIn: true, partInstruments }, bounds) };
}

test('instrument maps normalize to empty for old or malformed values and only retain exact known IDs on existing parts', () => {
  for (const value of [undefined, null, false, 1, 'piano-bright', [], ['piano-bright']]) {
    assert.deepEqual(sanitizeSession({ partInstruments: value }, bounds).partInstruments, {});
  }
  assert.deepEqual(sanitizeSession({}, bounds).partInstruments, {});
  assert.deepEqual(sanitizeSession({ partInstruments: { right: 'guitar-acoustic', left: 'piano-warm', drums: 'drums', unknown: 'strings' } }, bounds).partInstruments, { right: 'guitar-acoustic', left: 'piano-warm', drums: 'drums' });
  for (const value of ['piano', 'PIANO-BRIGHT', ' piano-bright ', 'unknown', 1, true, null, {}]) {
    assert.deepEqual(sanitizeSession({ partInstruments: { right: value } }, bounds).partInstruments, {});
  }
  for (const id of ids) assert.deepEqual(sanitizeSession({ partInstruments: { right: id } }, bounds).partInstruments, { right: id });
});

test('instrument map is a fresh own-entry copy, never inherited settings or a prototype setter', () => {
  const raw = Object.assign(Object.create({ left: 'strings' }), { right: 'piano-bright' });
  const first = sanitizeSession({ partInstruments: raw }, bounds);
  const second = sanitizeSession(first, bounds);
  assert.deepEqual(first.partInstruments, { right: 'piano-bright' });
  assert.notEqual(first.partInstruments, raw); assert.notEqual(second.partInstruments, first.partInstruments);
  raw.right = 'guitar-electric'; assert.equal(first.partInstruments?.right, 'piano-bright');
  first.partInstruments!.right = 'bass-electric'; assert.equal(second.partInstruments?.right, 'piano-bright');
  const special = sanitizeSession({ partInstruments: JSON.parse('{"__proto__":"drums"}') }, { ...bounds, partIds: ['__proto__'] }).partInstruments!;
  assert.equal(Object.getPrototypeOf(special), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(special, '__proto__')?.value, 'drums');
  assert.equal(({} as any).polluted, undefined);
});

test('v2 save/load isolates per-document instruments and preserves ordinary practice fields', async () => {
  const storage = new MemoryStorage();
  const a = document('a', { right: 'guitar-acoustic', left: 'bass-electric' });
  const b = document('b', { right: 'piano-warm', left: 'strings' });
  // Non-muted/non-solo parts must persist too, even though storage has no parsed score bounds.
  a.session.partInstruments!.drums = 'drums';
  assert.equal(saveDocuments(storage, [a, b]), true);
  const restored = await loadDocuments(storage);
  assert.equal(SESSION_KEY, 'scorecraft.documents.v2');
  assert.deepEqual(restored[0].session, a.session); assert.deepEqual(restored[1].session, b.session);
  a.session.partInstruments!.right = 'synth-pad'; assert.equal(restored[0].session.partInstruments?.right, 'guitar-acoustic');
  restored[0].session.partInstruments!.left = 'piano-bright'; assert.equal(restored[1].session.partInstruments?.left, 'strings');
  const reopened = sanitizeSession(restored[0].session, { ...bounds, partIds: ['right'] });
  assert.deepEqual(reopened.partInstruments, { right: 'guitar-acoustic' });
  assert.equal(reopened.position, 7.5); assert.equal(reopened.tempo, 140); assert.equal(reopened.countIn, true);
});

test('upsert/correction preserves instruments with stable ID while detaching mutable input map', () => {
  const original = document('c', { right: 'guitar-electric', left: 'piano-bright' });
  const corrected = { ...original, title: 'Corrected', xml: '<score-partwise corrected="true"/>' };
  const next = upsertDocument([original], corrected);
  assert.equal(next.length, 1); assert.equal(next[0].id, original.id); assert.deepEqual(next[0].session.partInstruments, original.session.partInstruments);
  assert.notEqual(next[0].session.partInstruments, original.session.partInstruments);
  original.session.partInstruments!.right = 'strings'; assert.equal(next[0].session.partInstruments?.right, 'guitar-electric');
  assert.equal(next[0].session.position, original.session.position); assert.deepEqual(next[0].session.muted, original.session.muted);
});

test('legacy v2 documents and v1 migration both materialize independent empty instrument maps', async () => {
  const oldV2 = new MemoryStorage();
  const old = document('d', {}); delete old.session.partInstruments;
  oldV2.setItem(SESSION_KEY, JSON.stringify([old]));
  const loaded = await loadDocuments(oldV2); assert.deepEqual(loaded[0].session.partInstruments, {});
  const legacy = new MemoryStorage();
  legacy.setItem(LEGACY_RECENT_KEY, JSON.stringify([{ title: 'Legacy', xml: '<legacy/>' }, { title: 'Legacy B', xml: '<legacyB/>' }]));
  const migrated = await loadDocuments(legacy);
  assert.equal(migrated.length, 2); assert.deepEqual(migrated[0].session.partInstruments, {}); assert.deepEqual(migrated[1].session.partInstruments, {});
  assert.notEqual(migrated[0].session.partInstruments, migrated[1].session.partInstruments);
});
