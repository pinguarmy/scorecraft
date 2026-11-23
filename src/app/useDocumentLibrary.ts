import { useCallback, useRef, useState } from 'react';
import { loadDocuments, saveDocuments, upsertDocument } from '../practice/session';
import type { RecentDocument } from '../practice/session';
import {
  createLibrarySaver,
  getOutboxEntry,
  listOutboxEntries,
  listSavedDocuments,
  migrateBrowserDocuments,
} from '../practice/library';
import type { LibrarySaveState, SavedDocumentMetadata } from '../practice/library';
import type { Notice } from './types';

/** localStorage 在隐私模式等情况下可能抛错；读取失败视为空。 */
const browserStorage = {
  getItem(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key: string, value: string) {
    localStorage.setItem(key, value);
  },
};

/**
 * 两层文档存储：
 * - 浏览器最近历史（localStorage，最多几份，用于快速恢复）；
 * - 本机谱库（服务器）与浏览器发件箱，经 createLibrarySaver 排队保存。
 *
 * librarySnapshots / libraryStates 是保存器回调与打开流程共享的同步副本，
 * 避免在异步流程里读到过期的 React 状态。
 */
export function useDocumentLibrary(setNotice: (notice: Notice) => void) {
  const [recent, setRecent] = useState<RecentDocument[]>([]);
  const [sessionReady, setSessionReady] = useState(false);
  const [savedDocuments, setSavedDocuments] = useState<SavedDocumentMetadata[]>([]);
  const [libraryError, setLibraryError] = useState('');
  const [saveStates, setSaveStates] = useState<Record<string, LibrarySaveState>>({});
  const recentRef = useRef<RecentDocument[]>([]);
  const hydrationRef = useRef<Promise<RecentDocument[]> | null>(null);
  // 清除最近历史后，本页之后的保存不再写回浏览器历史，直到打开另一份谱。
  const historySuppressed = useRef(false);
  const librarySnapshots = useRef(new Map<string, RecentDocument>());
  const libraryStates = useRef(new Map<string, LibrarySaveState>());
  const librarySaver = useRef<ReturnType<typeof createLibrarySaver> | null>(null);
  if (!librarySaver.current) {
    librarySaver.current = createLibrarySaver((state) => {
      libraryStates.current.set(state.id, state);
      setSaveStates((previous) => ({ ...previous, [state.id]: state }));
      const snapshot = librarySnapshots.current.get(state.id);
      if (state.status === 'saved' && state.receipt && snapshot) {
        const metadata: SavedDocumentMetadata = {
          id: snapshot.id,
          title: snapshot.title,
          composer: snapshot.composer,
          source: snapshot.source,
          jobId: snapshot.jobId,
          opened: snapshot.opened,
          updatedAt: state.receipt.updatedAt,
          xmlBytes: state.receipt.xmlBytes,
        };
        setSavedDocuments((previous) =>
          [metadata, ...previous.filter((item) => item.id !== state.id)].sort((a, b) => b.updatedAt - a.updatedAt),
        );
      }
    });
  }

  /**
   * 只执行一次的恢复：读浏览器历史、恢复发件箱中未保存的更改、读本机谱库，
   * 并把旧版浏览器历史迁移进谱库。所有打开流程都先等待它完成。
   */
  const ensureDocuments = useCallback(() => {
    if (!hydrationRef.current) {
      hydrationRef.current = (async () => {
        let docs: RecentDocument[];
        try {
          docs = await loadDocuments(browserStorage);
        } catch {
          docs = [];
        }
        recentRef.current = docs;
        setRecent(docs);
        try {
          const outboxEntries = await listOutboxEntries();
          for (const outboxEntry of outboxEntries) {
            librarySnapshots.current.set(outboxEntry.id, outboxEntry.document);
            if (outboxEntry.knownUpdatedAt !== undefined) {
              librarySaver.current?.setKnownVersion(outboxEntry.id, outboxEntry.knownUpdatedAt);
            }
            libraryStates.current.set(outboxEntry.id, {
              id: outboxEntry.id,
              status: 'error',
              error: '上次未保存的更改已保留。',
            });
            setSaveStates((previous) => ({
              ...previous,
              [outboxEntry.id]: { id: outboxEntry.id, status: 'error', error: '上次未保存的更改已保留。' },
            }));
          }
          const existing = await listSavedDocuments();
          setSavedDocuments(existing);
          await migrateBrowserDocuments(docs, new Set(existing.map((item) => item.id)));
          if (docs.some((doc) => !existing.some((item) => item.id === doc.id)))
            setSavedDocuments(await listSavedDocuments());
          setLibraryError('');
        } catch (error) {
          setLibraryError(`本机谱库暂不可用，浏览器历史仍保留。${error instanceof Error ? error.message : ''}`);
        }
        setSessionReady(true);
        return docs;
      })();
    }
    return hydrationRef.current;
  }, []);

  function persistRecent(next: RecentDocument[]) {
    recentRef.current = next;
    setRecent(next);
    if (!saveDocuments(browserStorage, next)) {
      setNotice({ kind: 'info', text: '浏览器存储空间不足。这份乐谱仍可练习，请导出 MusicXML 保存。' });
    }
  }

  /**
   * 保存一份文档快照：上次失败或冲突时只暂存（等待用户重试），否则排队保存。
   * 未清除历史且不太大的谱同时写入浏览器最近历史。
   */
  function saveDocument(item: RecentDocument) {
    librarySnapshots.current.set(item.id, item);
    const currentState = libraryStates.current.get(item.id);
    if (currentState?.status === 'error' || currentState?.status === 'conflict') {
      void librarySaver.current?.stage(item);
    } else {
      librarySaver.current?.enqueue(item);
    }
    if (!historySuppressed.current && item.xml.length <= 350_000)
      persistRecent(upsertDocument(recentRef.current, item));
  }

  function clearHistory() {
    historySuppressed.current = true;
    persistRecent([]);
    setNotice({
      kind: 'info',
      text: '已清除最近打开历史。已保存的谱和服务器扫描档案均未删除，本页仍会保存到本机谱库。',
    });
  }

  async function refreshLibrary() {
    try {
      setSavedDocuments(await listSavedDocuments());
      setLibraryError('');
    } catch (error) {
      setLibraryError(error instanceof Error ? error.message : '本机谱库暂不可用。');
    }
  }

  /** “重试保存” / “覆盖保存”。冲突或 force 时以本页快照覆盖服务器版本。 */
  function retrySave(id: string, force = false) {
    const isConflict = libraryStates.current.get(id)?.status === 'conflict';
    const snapshot = librarySnapshots.current.get(id);
    if (isConflict || force) {
      if (snapshot) {
        librarySaver.current?.retry(id, true);
        librarySaver.current?.enqueue(snapshot);
      } else {
        librarySaver.current?.retry(id, true);
      }
    } else {
      if (snapshot) librarySaver.current?.enqueue(snapshot);
      else librarySaver.current?.retry(id);
    }
  }

  /**
   * 这份文档是否有尚未写入谱库的本页更改：
   * 先看本页失败或冲突的快照，再看浏览器发件箱（上次会话遗留）。
   * 从发件箱找到时，同时恢复快照和已知的服务器版本号。
   */
  async function findPendingSnapshot(id: string): Promise<RecentDocument | undefined> {
    const state = libraryStates.current.get(id)?.status;
    let pending = state === 'error' || state === 'conflict' ? librarySnapshots.current.get(id) : undefined;
    if (!pending) {
      const outboxEntry = await getOutboxEntry(id);
      if (outboxEntry) {
        pending = outboxEntry.document;
        librarySnapshots.current.set(id, outboxEntry.document);
        if (outboxEntry.knownUpdatedAt !== undefined) {
          librarySaver.current?.setKnownVersion(id, outboxEntry.knownUpdatedAt);
        }
      }
    }
    return pending;
  }

  return {
    recent,
    recentRef,
    sessionReady,
    savedDocuments,
    libraryError,
    saveStates,
    historySuppressed,
    librarySnapshots,
    libraryStates,
    librarySaver,
    ensureDocuments,
    saveDocument,
    clearHistory,
    refreshLibrary,
    retrySave,
    findPendingSnapshot,
  };
}

export type DocumentLibrary = ReturnType<typeof useDocumentLibrary>;
