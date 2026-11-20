import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLibraryItems } from '../../src/app/library-items';
import { configurePlayer } from '../../src/app/player-config';
import type { ConfigurablePlayer } from '../../src/app/player-config';
import type { ScanJob } from '../../src/api/scorecraft';
import type { LibrarySaveState, SavedDocumentMetadata } from '../../src/practice/library';
import { sanitizeSession } from '../../src/practice/session';
import type { RecentDocument } from '../../src/practice/session';
import type { Score } from '../../src/music/types';

const jobA = '11111111-1111-4111-8111-111111111111';
const jobB = '22222222-2222-4222-8222-222222222222';
const jobC = '33333333-3333-4333-8333-333333333333';

const recentDoc = (id: string, opened: number, extra: Partial<RecentDocument> = {}): RecentDocument =>
  ({
    id,
    source: 's',
    title: `recent ${id}`,
    composer: '',
    xml: '<x/>',
    opened,
    session: {},
    ...extra,
  }) as RecentDocument;
const savedDoc = (id: string, opened: number, extra: Partial<SavedDocumentMetadata> = {}): SavedDocumentMetadata => ({
  id,
  title: `saved ${id}`,
  composer: '',
  source: 's',
  opened,
  updatedAt: opened,
  xmlBytes: 1,
  ...extra,
});
const scan = (id: string, status: ScanJob['status'], createdAt: number): ScanJob => ({
  id,
  status,
  createdAt,
  originalName: `scan ${id.slice(0, 1)}`,
});

test('library items merge sources with later sources overriding earlier ones', () => {
  const recent = [recentDoc('a', 10), recentDoc('b', 20)];
  const saved = [savedDoc('b', 25), savedDoc('c', 5)];
  const snapshot = recentDoc('c', 40, { title: 'edited c' });
  const states: Record<string, LibrarySaveState> = {
    c: { id: 'c', status: 'error', error: 'x' },
    ghost: { id: 'ghost', status: 'saving' },
  };
  const items = buildLibraryItems(recent, saved, states, new Map([['c', snapshot]]), []);
  assert.deepEqual(
    items.map((item) => [item.id, item.title, item.state, item.opened]),
    [
      ['c', 'edited c', 'unsaved', 40],
      ['b', 'saved b', 'saved', 25],
      ['a', 'recent a', 'cached', 10],
    ],
  );
  // A saved entry keeps the cached document reference so it can still be reopened from history.
  assert.equal(items[1].recent, recent[1]);
});

test('save states map to saved, saving and unsaved labels', () => {
  const snapshots = new Map(['x', 'y', 'z', 'w'].map((id, index) => [id, recentDoc(id, index)]));
  const states: Record<string, LibrarySaveState> = {
    x: { id: 'x', status: 'saved' },
    y: { id: 'y', status: 'saving' },
    z: { id: 'z', status: 'conflict' },
    w: { id: 'w', status: 'error' },
  };
  const byId = Object.fromEntries(
    buildLibraryItems([], [], states, snapshots, []).map((item) => [item.id, item.state]),
  );
  assert.deepEqual(byId, { x: 'saved', y: 'saving', z: 'unsaved', w: 'unsaved' });
});

test('only finished scans without a document are listed as scans', () => {
  const recent = [recentDoc('sha', 50, { jobId: jobA })];
  const saved = [savedDoc(`job:${jobB}`, 60)];
  const jobs = [
    scan(jobA, 'done', 1),
    scan(jobB, 'done', 2),
    scan(jobC, 'done', 3),
    scan(jobC.replace('3', '4'), 'error', 4),
  ];
  const items = buildLibraryItems(recent, saved, {}, new Map(), jobs);
  assert.deepEqual(
    items.map((item) => [item.id, item.state]),
    [
      [`job:${jobB}`, 'saved'],
      ['sha', 'cached'],
      [`job:${jobC}`, 'scan'],
    ],
  );
  const scanItem = items[2];
  assert.equal(scanItem.jobId, jobC);
  assert.equal(scanItem.title, 'scan 3');
  assert.equal(scanItem.scan, jobs[2]);
});

test('configurePlayer loads the score and applies the whole session before seeking', () => {
  const score = {
    title: 't',
    composer: '',
    tempo: 90,
    beatsPerMeasure: 4,
    parts: [
      { id: 'p1', name: 'A', instrument: 0, notes: [] },
      { id: 'p2', name: 'B', instrument: 0, notes: [] },
    ],
    measures: [
      { number: 1, startBeat: 0, duration: 4 },
      { number: 2, startBeat: 4, duration: 4 },
      { number: 3, startBeat: 8, duration: 4 },
    ],
    totalBeats: 12,
    warnings: [],
    xml: '<x/>',
  } satisfies Score;
  const session = sanitizeSession(
    {
      tempo: 70,
      transpose: -2,
      metronome: true,
      countIn: true,
      partInstruments: { p1: 'strings', p2: 'drums', missing: 'bass-electric' },
      muted: [],
      solo: 'p2',
      loop: true,
      loopStart: 2,
      loopEnd: 3,
      position: 5,
      followRepeats: false,
    },
    { tempo: 90, totalBeats: 12, measureCount: 3, partIds: ['p1', 'p2'] },
  );
  const calls: [string, ...unknown[]][] = [];
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
    };
  const player = Object.fromEntries(
    [
      'load',
      'setTempo',
      'setTranspose',
      'setMetronome',
      'setCountIn',
      'setPartInstruments',
      'setMutedParts',
      'setFollowRepeats',
      'setLoop',
      'seek',
    ].map((name) => [name, record(name)]),
  ) as unknown as ConfigurablePlayer;
  configurePlayer(player, score, session);
  assert.deepEqual(calls, [
    ['load', score],
    ['setTempo', 70],
    ['setTranspose', -2],
    ['setMetronome', true],
    ['setCountIn', true],
    // Drums are dropped for a part without percussion notes; unknown parts are ignored.
    ['setPartInstruments', { p1: 'strings' }],
    ['setMutedParts', ['p1']],
    ['setFollowRepeats', false],
    ['setLoop', 4, 12, true],
    ['seek', 5],
  ]);
  assert.doesNotThrow(() => configurePlayer(null, score, session));
});
