import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLibrarySaver,
  getOutboxDocument,
  listOutboxDocuments,
  putOutboxDocument,
  deleteOutboxDocument,
  saveSavedDocument,
  patchSavedSession,
  LibraryConflictError,
} from '../../src/practice/library';
import { sanitizeSession, type RecentDocument } from '../../src/practice/session';

const docId = `sha256:${'c'.repeat(64)}`;
function makeDoc(overrides: Partial<RecentDocument> = {}): RecentDocument {
  return {
    id: docId,
    title: 'Recovery test score',
    composer: 'Test composer',
    source: 'recovery-test.musicxml',
    xml: `<score-partwise><!--${'padding '.repeat(50000)}--></score-partwise>`, // >350k XML
    opened: 1000,
    session: sanitizeSession(null, { tempo: 120, totalBeats: 16, measureCount: 4, partIds: ['P'] }),
    ...overrides,
  };
}

const response = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

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

// In-memory IndexedDB mock for unit tests in Node environment
function setupMockIndexedDB() {
  const stores = new Map<string, Map<string, any>>();
  const mockIDB: Partial<IDBFactory> = {
    open(name: string, _version?: number) {
      const openReq: any = {
        result: null,
        error: null,
        onsuccess: null,
        onerror: null,
        onupgradeneeded: null,
      };
      setTimeout(() => {
        const db: any = {
          objectStoreNames: {
            contains: (storeName: string) => stores.has(storeName),
          },
          createObjectStore: (storeName: string, _opts: any) => {
            if (!stores.has(storeName)) stores.set(storeName, new Map());
            return {};
          },
          transaction: (storeNames: string | string[], _mode: string) => {
            const storeName = Array.isArray(storeNames) ? storeNames[0] : storeNames;
            if (!stores.has(storeName)) stores.set(storeName, new Map());
            const map = stores.get(storeName)!;
            const tx: any = {
              oncomplete: null,
              onerror: null,
              onabort: null,
              objectStore: (_name: string) => ({
                put: (val: any) => {
                  map.set(val.id, JSON.parse(JSON.stringify(val)));
                  setTimeout(() => tx.oncomplete?.({}), 0);
                },
                get: (key: string) => {
                  const req: any = { result: map.get(key) ? JSON.parse(JSON.stringify(map.get(key))) : undefined, onsuccess: null, onerror: null };
                  setTimeout(() => {
                    req.onsuccess?.({ target: req });
                    setTimeout(() => tx.oncomplete?.({}), 0);
                  }, 0);
                  return req;
                },
                getAll: () => {
                  const req: any = { result: [...map.values()].map(v => JSON.parse(JSON.stringify(v))), onsuccess: null, onerror: null };
                  setTimeout(() => {
                    req.onsuccess?.({ target: req });
                    setTimeout(() => tx.oncomplete?.({}), 0);
                  }, 0);
                  return req;
                },
                delete: (key: string) => {
                  map.delete(key);
                  setTimeout(() => tx.oncomplete?.({}), 0);
                },
              }),
            };
            return tx;
          },
          close: () => {},
        };
        openReq.result = db;
        if (openReq.onupgradeneeded) openReq.onupgradeneeded({ target: openReq });
        if (openReq.onsuccess) openReq.onsuccess({ target: openReq });
      }, 0);
      return openReq as IDBOpenDBRequest;
    },
  };
  return { mockIDB, stores };
}

test('optimistic concurrency 409 produces LibraryConflictError and preserves pending snapshot', async () => {
  const doc = makeDoc();
  await withFetch(
    (_url, init) => {
      assert.equal(init?.method, 'PUT');
      assert.equal((init?.headers as any)?.['If-Match'], '"1000"');
      return response({ message: '乐谱版本冲突：已被其他窗口更新，未覆盖较新版本。' }, 409);
    },
    async () => {
      await assert.rejects(
        saveSavedDocument(doc, undefined, false, 1000),
        (err: any) => err instanceof LibraryConflictError && err.status === 409,
      );
    },
  );
});

test('session PATCH transmits If-Match and recognizes 409 conflict', async () => {
  const doc = makeDoc();
  await withFetch(
    (_url, init) => {
      assert.equal(init?.method, 'PATCH');
      assert.equal((init?.headers as any)?.['If-Match'], '"2000"');
      return response({ message: '练习设置版本冲突：已被其他窗口更新，未覆盖较新内容。' }, 409);
    },
    async () => {
      await assert.rejects(
        patchSavedSession(doc.id, doc.session, doc.opened, undefined, 2000),
        (err: any) => err instanceof LibraryConflictError && err.status === 409,
      );
    },
  );
});

test('createLibrarySaver records conflict state on 409 and force retry clears version constraint', async () => {
  const states: string[] = [];
  const doc = makeDoc();
  let putCount = 0;
  let sentIfMatch: string | undefined;

  await withFetch(
    (_url, init) => {
      putCount++;
      sentIfMatch = (init?.headers as any)?.['If-Match'];
      if (putCount === 1) {
        return response({ message: '乐谱版本冲突' }, 409);
      }
      return response({ id: doc.id, updatedAt: 3000, xmlBytes: 500000 });
    },
    async () => {
      const saver = createLibrarySaver(state => states.push(state.status));
      saver.setKnownVersion(doc.id, 1000);
      saver.enqueue(doc);
      await saver.flush();

      assert.equal(putCount, 1);
      assert.equal(sentIfMatch, '"1000"');
      assert.deepEqual(states, ['saving', 'conflict']);

      // Force retry: clears version constraint, allowing overwrite
      saver.retry(doc.id, true);
      await saver.flush();

      assert.equal(putCount, 2);
      assert.equal(sentIfMatch, undefined, 'force retry must not send outdated If-Match');
      assert.deepEqual(states, ['saving', 'conflict', 'saving', 'saved']);
    },
  );
});

test('IndexedDB pending outbox persists before network save and cleans up after success', async () => {
  const { mockIDB, stores } = setupMockIndexedDB();
  (globalThis as any).indexedDB = mockIDB;

  try {
    const doc = makeDoc();
    assert(doc.xml.length > 350_000, 'XML must be greater than 350k');

    // 1. putOutboxDocument directly works
    await putOutboxDocument(doc);
    const loaded = await getOutboxDocument(doc.id);
    assert(loaded);
    assert.equal(loaded.xml, doc.xml);
    assert.equal(loaded.title, doc.title);

    const all = await listOutboxDocuments();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, doc.id);

    await deleteOutboxDocument(doc.id);
    assert.equal(await getOutboxDocument(doc.id), null);

    // 2. createLibrarySaver integrates with outbox: persists on enqueue, clears on save
    let releaseNet!: () => void;
    await withFetch(
      () => new Promise(resolve => { releaseNet = () => resolve(response({ id: doc.id, updatedAt: 5000, xmlBytes: doc.xml.length })); }),
      async () => {
        const saver = createLibrarySaver(() => {});
        saver.enqueue(doc);

        // Before network releases, the outbox already has the pending document
        // (Wait for microtasks)
        await new Promise(r => setTimeout(r, 10));
        const inFlight = await getOutboxDocument(doc.id);
        assert(inFlight, 'pending document must be in outbox before network completes');
        assert.equal(inFlight.id, doc.id);

        // Release network save
        releaseNet();
        await saver.flush();

        // After successful save, outbox is cleared
        await new Promise(r => setTimeout(r, 10));
        const postSave = await getOutboxDocument(doc.id);
        assert.equal(postSave, null, 'outbox must be deleted after successful save');
      },
    );

    // 3. Network failure keeps document in outbox for recovery
    await withFetch(
      () => Promise.reject(new Error('Network aborted')),
      async () => {
        const saver = createLibrarySaver(() => {});
        saver.enqueue(doc);
        await saver.flush();

        await new Promise(r => setTimeout(r, 10));
        const retained = await getOutboxDocument(doc.id);
        assert(retained, 'outbox must retain pending document when network fails');
        assert.equal(retained.xml, doc.xml);
      },
    );
  } finally {
    delete (globalThis as any).indexedDB;
  }
});

test('slow PUT A -> enqueue B -> when A finishes outbox still contains B', async () => {
  const { mockIDB } = setupMockIndexedDB();
  (globalThis as any).indexedDB = mockIDB;

  try {
    const docA = makeDoc({ title: 'Version A', xml: '<score-partwise><!--version A--></score-partwise>' });
    const docB = makeDoc({ title: 'Version B', xml: '<score-partwise><!--version B--></score-partwise>' });

    let resolvePutA!: (res: Response) => void;
    let resolvePutB!: (res: Response) => void;
    let putCount = 0;

    await withFetch(
      (_url, init) => {
        putCount++;
        if (putCount === 1) {
          assert.equal(JSON.parse(String(init?.body)).title, 'Version A');
          return new Promise(resolve => { resolvePutA = resolve; });
        } else {
          assert.equal(JSON.parse(String(init?.body)).title, 'Version B');
          return new Promise(resolve => { resolvePutB = resolve; });
        }
      },
      async () => {
        const saver = createLibrarySaver(() => {});

        // 1. Enqueue A (slow PUT)
        saver.enqueue(docA);
        await new Promise(r => setTimeout(r, 15));
        assert.equal(putCount, 1);

        // 2. While A is in-flight, user edits to B
        saver.enqueue(docB);
        await new Promise(r => setTimeout(r, 15));

        // 3. Complete PUT A
        resolvePutA(response({ id: docA.id, updatedAt: 1001, xmlBytes: docA.xml.length }));
        await new Promise(r => setTimeout(r, 20));

        // Crucial assertion: Outbox MUST NOT be deleted when A finishes! It must contain Version B!
        const outboxDuringB = await getOutboxDocument(docA.id);
        assert(outboxDuringB, 'outbox must not be deleted when A finishes while B is pending');
        assert.equal(outboxDuringB.title, 'Version B');
        assert.equal(outboxDuringB.xml, docB.xml);

        // 4. Complete PUT B
        assert.equal(putCount, 2);
        resolvePutB(response({ id: docB.id, updatedAt: 1002, xmlBytes: docB.xml.length }));
        await saver.flush();

        // 5. Now that B completed without further edits, outbox is cleaned up
        await new Promise(r => setTimeout(r, 15));
        const outboxAfterB = await getOutboxDocument(docA.id);
        assert.equal(outboxAfterB, null, 'outbox must be cleared only after the latest snapshot B finishes');
      },
    );
  } finally {
    delete (globalThis as any).indexedDB;
  }
});

test('stage() persists latest edit to outbox without auto-retrying network save during error/conflict', async () => {
  const { mockIDB } = setupMockIndexedDB();
  (globalThis as any).indexedDB = mockIDB;

  try {
    const doc1 = makeDoc({ title: 'Edit 1' });
    const doc2 = makeDoc({ title: 'Edit 2 while failed' });
    let netCalls = 0;

    await withFetch(
      () => {
        netCalls++;
        return Promise.reject(new Error('Network error on save'));
      },
      async () => {
        const saver = createLibrarySaver(() => {});
        saver.enqueue(doc1);
        await saver.flush();
        assert.equal(netCalls, 1);

        // Now saver is in failed state. User makes another edit: stage() is called
        await saver.stage(doc2);

        // Assert NO new network call was triggered!
        assert.equal(netCalls, 1, 'stage() must not trigger network request');

        // Assert IndexedDB outbox was updated with Edit 2!
        const outboxEntry = await getOutboxDocument(doc1.id);
        assert(outboxEntry, 'outbox must contain staged document');
        assert.equal(outboxEntry.title, 'Edit 2 while failed');
      },
    );
  } finally {
    delete (globalThis as any).indexedDB;
  }
});

test('outbox preserves knownUpdatedAt base version and conflict detection across simulated reload', async () => {
  const { mockIDB } = setupMockIndexedDB();
  (globalThis as any).indexedDB = mockIDB;

  try {
    const doc = makeDoc({ title: 'Version with known base' });
    const baseVersion = 12345;

    // 1. Stage in outbox with baseVersion
    const saver1 = createLibrarySaver(() => {});
    await saver1.stage(doc, baseVersion);

    // 2. Simulate reload: read outbox entries
    const entries = await listOutboxDocuments();
    assert.equal(entries.length, 1);

    const { getOutboxEntry } = await import('../../src/practice/library');
    const entry = await getOutboxEntry(doc.id);
    assert(entry);
    assert.equal(entry.knownUpdatedAt, baseVersion);

    // 3. New saver instance on new page: restore knownVersion from outbox
    let sentIfMatch: string | undefined;
    await withFetch(
      (_url, init) => {
        sentIfMatch = (init?.headers as any)?.['If-Match'];
        return response({ message: '版本冲突' }, 409);
      },
      async () => {
        const saver2 = createLibrarySaver(() => {});
        saver2.setKnownVersion(entry.id, entry.knownUpdatedAt!);
        saver2.enqueue(entry.document);
        await saver2.flush();

        // Must have sent If-Match with baseVersion!
        assert.equal(sentIfMatch, `"${baseVersion}"`, 'reloaded retry must transmit baseVersion If-Match');
      },
    );
  } finally {
    delete (globalThis as any).indexedDB;
  }
});

test('IndexedDB write failure produces explicit outboxError in save state and does not falsely claim safe', async () => {
  const brokenIDB: Partial<IDBFactory> = {
    open() {
      const openReq: any = { onerror: null, onsuccess: null };
      setTimeout(() => {
        openReq.error = new Error('QuotaExceededError: disk is full');
        if (typeof openReq.onerror === 'function') openReq.onerror(new Event('error'));
      }, 0);
      return openReq as IDBOpenDBRequest;
    },
  };
  (globalThis as any).indexedDB = brokenIDB;
  (globalThis as any).window = { indexedDB: brokenIDB };

  try {
    const doc = makeDoc();
    const states: any[] = [];
    let reportedOutboxError: Error | undefined;

    await withFetch(
      () => response({ id: doc.id, updatedAt: 2000, xmlBytes: doc.xml.length }),
      async () => {
        const saver = createLibrarySaver(
          state => states.push(state),
          (_id, err) => { reportedOutboxError = err; },
        );
        saver.enqueue(doc);
        await saver.flush();

        // Wait for outbox write attempt to reject
        await new Promise(r => setTimeout(r, 20));

        assert(reportedOutboxError, 'onOutboxError must be called when IDB fails');
        assert.match(reportedOutboxError.message, /QuotaExceededError|打开本地离线存储失败/);

        // State must report outboxError
        const stateWithOutboxError = states.find(s => s.outboxError);
        assert(stateWithOutboxError, 'state must carry outboxError');
        assert.match(stateWithOutboxError.outboxError, /本地离线备份失败/);
      },
    );
  } finally {
    delete (globalThis as any).indexedDB;
    delete (globalThis as any).window;
  }
});
