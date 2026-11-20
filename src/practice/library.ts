import { isValidDocId, type PracticeSession, type RecentDocument } from './session';

export type SavedDocumentMetadata = {
  id: string;
  title: string;
  composer: string;
  source: string;
  jobId?: string;
  opened: number;
  updatedAt: number;
  xmlBytes: number;
};
export type RemoteSavedDocument = Omit<RecentDocument, 'session'> & {
  session: unknown;
  updatedAt?: number;
  xmlBytes?: number;
};
export type SaveReceipt = { id: string; updatedAt: number; xmlBytes: number };
export type LibrarySaveState = {
  id: string;
  status: 'saving' | 'saved' | 'error' | 'conflict';
  error?: string;
  receipt?: SaveReceipt;
  outboxError?: string;
};
const MAX_XML_BYTES = 8 * 1024 * 1024;
const endpoint = (id: string) => {
  if (!isValidDocId(id) || id !== id.trim()) throw new Error('乐谱编号无效。');
  return `/api/library/${encodeURIComponent(id)}`;
};

export class LibraryConflictError extends Error {
  status = 409;
  constructor(message = '乐谱版本冲突：已被其他窗口更新，未覆盖较新版本。') {
    super(message);
    this.name = 'LibraryConflictError';
  }
}

async function failure(response: Response): Promise<Error> {
  let message = `本机谱库请求失败（HTTP ${response.status}）。`;
  try {
    const body = await response.json();
    if (typeof body?.message === 'string') message = body.message;
  } catch {
    /* A non-JSON server error still has an actionable HTTP status. */
  }
  if (response.status === 409) return new LibraryConflictError(message);
  return new Error(message);
}
async function checked(response: Response) {
  if (!response.ok) throw await failure(response);
  return response.json();
}
function checkXml(xml: unknown): asserts xml is string {
  if (typeof xml !== 'string' || !xml.length || new TextEncoder().encode(xml).byteLength > MAX_XML_BYTES)
    throw new Error('乐谱内容为空或超过本机谱库 8 MiB 上限。');
}

// Native IndexedDB Outbox Persistence for pending changes
export type OutboxEntry = {
  id: string;
  document: RecentDocument;
  revision: number;
  knownUpdatedAt?: number;
};

const OUTBOX_DB_NAME = 'scorecraft-library-outbox';
const OUTBOX_STORE_NAME = 'pending-documents';

function getIndexedDB(): IDBFactory | undefined {
  if (typeof indexedDB !== 'undefined') return indexedDB;
  if (typeof window !== 'undefined' && window.indexedDB) return window.indexedDB;
  return undefined;
}

function openOutboxDB(): Promise<IDBDatabase> {
  const idb = getIndexedDB();
  if (!idb) {
    if (typeof window === 'undefined') {
      return Promise.reject(new Error('IndexedDB 在非浏览器环境中未提供'));
    }
    return Promise.reject(new Error('浏览器未启用或不支持 IndexedDB'));
  }
  return new Promise((resolve, reject) => {
    try {
      const request = idb.open(OUTBOX_DB_NAME, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(OUTBOX_STORE_NAME)) {
          db.createObjectStore(OUTBOX_STORE_NAME, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('打开本地离线存储失败'));
    } catch (err) {
      reject(err instanceof Error ? err : new Error('打开本地离线存储失败'));
    }
  });
}

const outboxQueues = new Map<string, Promise<unknown>>();

function queueOutboxOp<T>(id: string, op: () => Promise<T>): Promise<T> {
  const previous = outboxQueues.get(id) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(op);
  const cleaned = current.finally(() => {
    if (outboxQueues.get(id) === cleaned) outboxQueues.delete(id);
  });
  cleaned.catch(() => {});
  outboxQueues.set(id, cleaned);
  return current;
}

export async function putOutboxEntry(entry: OutboxEntry): Promise<void> {
  const idb = getIndexedDB();
  if (!idb && typeof window === 'undefined') return;
  return queueOutboxOp(entry.id, async () => {
    const db = await openOutboxDB();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(OUTBOX_STORE_NAME, 'readwrite');
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('写入本地离线快照失败'));
        tx.onabort = () => reject(tx.error || new Error('写入本地离线快照被中止'));
        tx.objectStore(OUTBOX_STORE_NAME).put(entry);
      });
    } finally {
      db.close();
    }
  });
}

export async function deleteOutboxEntry(id: string, revision?: number): Promise<boolean> {
  const idb = getIndexedDB();
  if (!idb && typeof window === 'undefined') return false;
  return queueOutboxOp(id, async () => {
    const db = await openOutboxDB();
    try {
      return await new Promise<boolean>((resolve, reject) => {
        const tx = db.transaction(OUTBOX_STORE_NAME, 'readwrite');
        const store = tx.objectStore(OUTBOX_STORE_NAME);
        let deleted = false;
        if (revision !== undefined) {
          const getReq = store.get(id);
          getReq.onsuccess = () => {
            const current = getReq.result as OutboxEntry | undefined;
            if (current && current.revision <= revision) {
              store.delete(id);
              deleted = true;
            }
          };
          getReq.onerror = () => reject(getReq.error || new Error('读取本地快照失败'));
        } else {
          store.delete(id);
          deleted = true;
        }
        tx.oncomplete = () => resolve(deleted);
        tx.onerror = () => reject(tx.error || new Error('清理本地快照失败'));
        tx.onabort = () => reject(tx.error || new Error('清理本地快照被中止'));
      });
    } finally {
      db.close();
    }
  });
}

export async function getOutboxEntry(id: string): Promise<OutboxEntry | null> {
  const idb = getIndexedDB();
  if (!idb && typeof window === 'undefined') return null;
  return queueOutboxOp(id, async () => {
    const db = await openOutboxDB();
    try {
      return await new Promise<OutboxEntry | null>((resolve, reject) => {
        const tx = db.transaction(OUTBOX_STORE_NAME, 'readonly');
        const req = tx.objectStore(OUTBOX_STORE_NAME).get(id);
        req.onsuccess = () => resolve((req.result as OutboxEntry) || null);
        req.onerror = () => reject(req.error || new Error('读取本地快照失败'));
      });
    } finally {
      db.close();
    }
  });
}

export async function listOutboxEntries(): Promise<OutboxEntry[]> {
  const idb = getIndexedDB();
  if (!idb && typeof window === 'undefined') return [];
  const db = await openOutboxDB();
  try {
    return await new Promise<OutboxEntry[]>((resolve, reject) => {
      const tx = db.transaction(OUTBOX_STORE_NAME, 'readonly');
      const req = tx.objectStore(OUTBOX_STORE_NAME).getAll();
      req.onsuccess = () => resolve((req.result as OutboxEntry[]) || []);
      req.onerror = () => reject(req.error || new Error('列出本地快照失败'));
    });
  } finally {
    db.close();
  }
}

// Backward compatibility wrappers for callers expecting documents
export async function putOutboxDocument(doc: RecentDocument, revision = 1, knownUpdatedAt?: number): Promise<void> {
  return putOutboxEntry({ id: doc.id, document: doc, revision, knownUpdatedAt });
}

export async function deleteOutboxDocument(id: string): Promise<void> {
  await deleteOutboxEntry(id);
}

export async function getOutboxDocument(id: string): Promise<RecentDocument | null> {
  const entry = await getOutboxEntry(id);
  return entry?.document || null;
}

export async function listOutboxDocuments(): Promise<RecentDocument[]> {
  const entries = await listOutboxEntries();
  return entries.map((e) => e.document);
}

export async function listSavedDocuments(signal?: AbortSignal): Promise<SavedDocumentMetadata[]> {
  const data = await checked(await fetch('/api/library', { signal }));
  if (!Array.isArray(data.documents)) throw new Error('本机谱库列表格式无效。');
  return data.documents.map((item: SavedDocumentMetadata) => {
    if (!item || !isValidDocId(item.id) || typeof item.title !== 'string' || !Number.isFinite(item.updatedAt))
      throw new Error('本机谱库条目格式无效。');
    return item;
  });
}
export async function getSavedDocument(id: string, signal?: AbortSignal): Promise<RemoteSavedDocument | null> {
  const response = await fetch(endpoint(id), { signal });
  if (response.status === 404) return null;
  const item = await checked(response);
  if (
    item.id !== id ||
    typeof item.title !== 'string' ||
    typeof item.composer !== 'string' ||
    typeof item.source !== 'string' ||
    !Number.isFinite(item.opened)
  )
    throw new Error('已保存乐谱格式无效。');
  checkXml(item.xml);
  // Session is deliberately untrusted until App has parsed the score and knows its actual bounds.
  return item as RemoteSavedDocument;
}
export async function saveSavedDocument(
  document: RecentDocument,
  signal?: AbortSignal,
  createOnly = false,
  ifMatch?: number,
): Promise<SaveReceipt | null> {
  checkXml(document.xml);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ifMatch !== undefined) headers['If-Match'] = `"${ifMatch}"`;
  const response = await fetch(`${endpoint(document.id)}${createOnly ? '?createOnly=1' : ''}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(document),
    signal,
  });
  if (createOnly && response.status === 409) return null;
  return checked(response);
}
export async function patchSavedSession(
  id: string,
  session: PracticeSession,
  opened: number,
  signal?: AbortSignal,
  ifMatch?: number,
): Promise<SaveReceipt> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ifMatch !== undefined) headers['If-Match'] = `"${ifMatch}"`;
  return checked(
    await fetch(`${endpoint(id)}/session`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ session, opened }),
      signal,
    }),
  );
}
export async function migrateBrowserDocuments(
  documents: readonly RecentDocument[],
  existingIds: ReadonlySet<string> = new Set(),
  signal?: AbortSignal,
): Promise<void> {
  for (const document of documents) if (!existingIds.has(document.id)) await saveSavedDocument(document, signal, true);
}
function snapshot(document: RecentDocument): RecentDocument {
  return {
    ...document,
    session: {
      ...document.session,
      muted: [...document.session.muted],
      partInstruments: { ...document.session.partInstruments },
    },
  };
}
function sameContent(a: RecentDocument, b: RecentDocument) {
  return (
    a.xml === b.xml && a.title === b.title && a.composer === b.composer && a.source === b.source && a.jobId === b.jobId
  );
}
function sameSession(a: RecentDocument, b: RecentDocument) {
  return a.opened === b.opened && JSON.stringify(a.session) === JSON.stringify(b.session);
}
/** Per-document ordering keeps a slow old request from overwriting newer work.
 * An in-flight write is followed only by the latest queued snapshot. */
export function createLibrarySaver(
  onState: (state: LibrarySaveState) => void,
  onOutboxError?: (id: string, error: Error) => void,
) {
  type Entry = {
    pending?: RecentDocument;
    saved?: RecentDocument;
    running?: Promise<void>;
    failed?: boolean;
    conflict?: boolean;
    receipt?: SaveReceipt;
    knownUpdatedAt?: number;
    revision: number;
    savedRevision?: number;
    outboxError?: string;
  };
  const entries = new Map<string, Entry>();

  async function persistOutbox(id: string, entry: Entry): Promise<void> {
    if (!entry.pending) return;
    const docToPersist = entry.pending;
    const revToPersist = entry.revision;
    const versionToPersist = entry.knownUpdatedAt;
    try {
      await putOutboxEntry({
        id,
        document: docToPersist,
        revision: revToPersist,
        knownUpdatedAt: versionToPersist,
      });
      entry.outboxError = undefined;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      entry.outboxError = `本地离线备份失败（${error.message}），请及时导出 MusicXML。`;
      onOutboxError?.(id, error);
      if (entry.failed || entry.conflict) {
        onState({
          id,
          status: entry.conflict ? 'conflict' : 'error',
          error: entry.conflict ? '乐谱版本冲突：已被其他窗口更新，未覆盖较新版本。' : '保存到本机谱库失败。',
          outboxError: entry.outboxError,
        });
      }
    }
  }

  function launch(id: string, entry: Entry) {
    if (entry.running || entry.failed || entry.conflict || !entry.pending) return;
    entry.running = (async () => {
      while (entry.pending && !entry.failed && !entry.conflict) {
        const document = entry.pending;
        const currentRevision = entry.revision;
        entry.pending = undefined;

        if (entry.saved && sameContent(entry.saved, document) && sameSession(entry.saved, document)) {
          entry.savedRevision = currentRevision;
          if (entry.revision === currentRevision && !entry.pending) {
            try {
              await deleteOutboxEntry(id, currentRevision);
            } catch {}
          }
          if (!entry.pending) onState({ id, status: 'saved', receipt: entry.receipt, outboxError: entry.outboxError });
          continue;
        }

        onState({ id, status: 'saving', outboxError: entry.outboxError });
        try {
          const receipt =
            entry.saved && sameContent(entry.saved, document)
              ? await patchSavedSession(id, document.session, document.opened, undefined, entry.knownUpdatedAt)
              : await saveSavedDocument(document, undefined, false, entry.knownUpdatedAt);

          entry.saved = document;
          entry.savedRevision = currentRevision;
          entry.receipt = receipt ?? undefined;
          if (receipt?.updatedAt !== undefined) {
            entry.knownUpdatedAt = receipt.updatedAt;
          }

          // Only delete outbox if no newer pending snapshot was queued during in-flight save
          if (entry.revision === currentRevision && !entry.pending) {
            try {
              await deleteOutboxEntry(id, currentRevision);
            } catch {}
          }

          if (!entry.pending) onState({ id, status: 'saved', receipt: entry.receipt, outboxError: entry.outboxError });
        } catch (error) {
          entry.pending ??= document;
          if (error instanceof LibraryConflictError) {
            entry.conflict = true;
            onState({ id, status: 'conflict', error: error.message, outboxError: entry.outboxError });
          } else {
            entry.failed = true;
            onState({
              id,
              status: 'error',
              error: error instanceof Error ? error.message : '保存到本机谱库失败。',
              outboxError: entry.outboxError,
            });
          }
        }
      }
    })().finally(() => {
      entry.running = undefined;
      if (entry.pending && !entry.failed && !entry.conflict) launch(id, entry);
    });
  }

  return {
    enqueue(document: RecentDocument, knownVersion?: number): void {
      endpoint(document.id);
      const entry = entries.get(document.id) ?? { revision: 0 };
      entries.set(document.id, entry);
      entry.revision = (entry.revision || 0) + 1;
      entry.pending = snapshot(document);
      entry.failed = false;
      entry.conflict = false;
      if (knownVersion !== undefined && entry.knownUpdatedAt === undefined) {
        entry.knownUpdatedAt = knownVersion;
      }
      void persistOutbox(document.id, entry);
      launch(document.id, entry);
    },

    stage(document: RecentDocument, knownVersion?: number): Promise<void> {
      endpoint(document.id);
      const entry = entries.get(document.id) ?? { revision: 0 };
      entries.set(document.id, entry);
      entry.revision = (entry.revision || 0) + 1;
      entry.pending = snapshot(document);
      if (knownVersion !== undefined && entry.knownUpdatedAt === undefined) {
        entry.knownUpdatedAt = knownVersion;
      }
      return persistOutbox(document.id, entry);
    },

    setKnownVersion(id: string, version: number): void {
      const entry = entries.get(id) ?? { revision: 0 };
      entries.set(id, entry);
      entry.knownUpdatedAt = version;
    },

    setSaved(document: RecentDocument, version?: number): void {
      const entry = entries.get(document.id) ?? { revision: 0 };
      entries.set(document.id, entry);
      entry.saved = snapshot(document);
      if (version !== undefined) {
        entry.knownUpdatedAt = version;
      }
    },

    getKnownVersion(id: string): number | undefined {
      return entries.get(id)?.knownUpdatedAt;
    },

    async flush(): Promise<void> {
      for (const [id, entry] of entries) launch(id, entry);
      while ([...entries.values()].some((entry) => entry.running))
        await Promise.all([...entries.values()].map((entry) => entry.running));
    },

    retry(id?: string, force = false): void {
      for (const [key, entry] of entries) {
        if (id === undefined || key === id) {
          entry.failed = false;
          if (force) {
            entry.conflict = false;
            entry.knownUpdatedAt = undefined;
          }
          if (entry.pending) void persistOutbox(key, entry);
          launch(key, entry);
        }
      }
    },
  };
}
