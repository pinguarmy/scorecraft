import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLibrarySaver,
  getSavedDocument,
  migrateBrowserDocuments,
  saveSavedDocument,
} from '../../src/practice/library';
import { sanitizeSession, type RecentDocument } from '../../src/practice/session';
const id = `sha256:${'a'.repeat(64)}`;
const secondId = `sha256:${'b'.repeat(64)}`;
function document(overrides: Partial<RecentDocument> = {}): RecentDocument {
  return {
    id,
    title: 'Original saved score',
    composer: '',
    source: 'memory-only test',
    xml: '<score-partwise/>',
    opened: 1,
    session: sanitizeSession(null, { tempo: 88, totalBeats: 16, measureCount: 4, partIds: ['P'] }),
    ...overrides,
  };
}
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const receipt = (key = id) => ({ id: key, updatedAt: 1000, xmlBytes: 850000 });
async function withFetch(
  callback: (url: string, init?: RequestInit) => Promise<Response> | Response,
  run: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(callback(String(url), init))) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

test('large full documents are saved intact; missing alone returns null', async () => {
  const doc = document({ xml: `<score-partwise>${' '.repeat(850000)}</score-partwise>` });
  await withFetch(
    (url, init) => {
      if (init?.method === 'PUT') {
        assert.equal(JSON.parse(String(init.body)).xml, doc.xml);
        return response(receipt());
      }
      return response(doc);
    },
    async () => {
      assert.equal((await saveSavedDocument(doc))?.id, id);
      assert.equal((await getSavedDocument(id))?.xml, doc.xml);
    },
  );
  await withFetch(
    () => response({ message: 'missing' }, 404),
    async () => assert.equal(await getSavedDocument(id), null),
  );
  await withFetch(
    () => response({ message: 'disk unavailable' }, 500),
    async () => {
      await assert.rejects(getSavedDocument(id), /disk unavailable/);
    },
  );
});

test('migration creates missing documents only and never replaces an existing correction', async () => {
  const calls: string[] = [];
  await withFetch(
    (url, init) => {
      calls.push(url);
      assert.equal(init?.method, 'PUT');
      assert(url.endsWith('?createOnly=1'));
      return response({ message: 'already exists' }, 409);
    },
    async () => {
      await migrateBrowserDocuments([document(), document({ id: secondId })], new Set([id]));
    },
  );
  assert.equal(calls.length, 1);
  assert(calls[0].includes(encodeURIComponent(secondId)));
});

test('saver serializes an in-flight score and collapses queued edits to the newest snapshot', async () => {
  let release!: (value: Response) => void;
  const bodies: RecentDocument[] = [];
  const states: string[] = [];
  await withFetch(
    (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      if (bodies.length === 1)
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      return response(receipt());
    },
    async () => {
      const saver = createLibrarySaver((state) => states.push(state.status));
      saver.enqueue(document());
      saver.enqueue(document({ xml: '<score-partwise>middle</score-partwise>' }));
      saver.enqueue(document({ xml: '<score-partwise>latest</score-partwise>' }));
      assert.equal(bodies.length, 1);
      release(response(receipt()));
      await saver.flush();
      assert.equal(bodies.length, 2);
      assert.equal(bodies[1].xml, '<score-partwise>latest</score-partwise>');
      assert.deepEqual(states, ['saving', 'saving', 'saved']);
    },
  );
});

test('session-only updates PATCH without resending XML and saved snapshots are isolated', async () => {
  const calls: { url: string; method?: string; body: any }[] = [];
  await withFetch(
    (url, init) => {
      calls.push({ url, method: init?.method, body: JSON.parse(String(init?.body)) });
      return response(receipt());
    },
    async () => {
      const saver = createLibrarySaver(() => {});
      const first = document();
      saver.enqueue(first);
      first.session.muted.push('P');
      await saver.flush();
      assert.deepEqual(calls[0].body.session.muted, []);
      saver.enqueue(document({ opened: 2, session: { ...first.session, position: 4 } }));
      await saver.flush();
      assert.equal(calls[1].method, 'PATCH');
      assert(calls[1].url.endsWith('/session'));
      assert.equal(calls[1].body.xml, undefined);
      assert.equal(calls[1].body.session.position, 4);
      saver.enqueue(document({ id: secondId }));
      await saver.flush();
      assert.equal(calls[2].method, 'PUT');
      assert(calls[2].url.includes(encodeURIComponent(secondId)));
    },
  );
});

test('failed writes remain retryable and do not report saved or retry in a loop', async () => {
  let calls = 0;
  const states: string[] = [];
  await withFetch(
    () => (++calls === 1 ? response({ message: 'disk full' }, 507) : response(receipt())),
    async () => {
      const saver = createLibrarySaver((state) => states.push(state.status));
      saver.enqueue(document());
      await saver.flush();
      assert.equal(calls, 1);
      assert.deepEqual(states, ['saving', 'error']);
      saver.retry(id);
      await saver.flush();
      assert.equal(calls, 2);
      assert.deepEqual(states, ['saving', 'error', 'saving', 'saved']);
    },
  );
});
