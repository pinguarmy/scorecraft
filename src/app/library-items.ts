// “我的乐谱”列表：合并浏览器最近缓存、本机谱库、待保存快照和已完成的扫描。
import type { ScanJob } from '../api/scorecraft';
import type { LibrarySaveState, SavedDocumentMetadata } from '../practice/library';
import type { RecentDocument } from '../practice/session';

export type LibraryItemState = 'saved' | 'saving' | 'unsaved' | 'cached' | 'scan';

export type LibraryItem = {
  id: string;
  title: string;
  opened: number;
  jobId?: string;
  state: LibraryItemState;
  recent?: RecentDocument;
  scan?: ScanJob;
};

export const libraryItemStateLabels: Record<LibraryItemState, string> = {
  saved: '已保存',
  saving: '保存中',
  unsaved: '未保存',
  cached: '最近缓存',
  scan: '扫描已完成',
};

/** 列表中显示的曲名；空白曲名显示为“未命名乐谱”，按钮的可访问名称也用它。 */
export const libraryItemTitle = (title: string | undefined) => title?.trim() || '未命名乐谱';

/**
 * 后来的来源覆盖先前的同名条目：最近缓存 → 本机谱库 → 本页保存状态（需有快照）。
 * 已完成的扫描只在没有对应文档时单独列出。结果按打开时间从新到旧排序。
 */
export function buildLibraryItems(
  recent: readonly RecentDocument[],
  savedDocuments: readonly SavedDocumentMetadata[],
  saveStates: Readonly<Record<string, LibrarySaveState>>,
  snapshots: ReadonlyMap<string, RecentDocument>,
  scanJobs: readonly ScanJob[],
): LibraryItem[] {
  const items = new Map<string, LibraryItem>();
  for (const doc of recent) {
    items.set(doc.id, {
      id: doc.id,
      title: libraryItemTitle(doc.title),
      opened: doc.opened,
      jobId: doc.jobId,
      state: 'cached',
      recent: doc,
    });
  }
  for (const doc of savedDocuments) {
    items.set(doc.id, {
      ...items.get(doc.id),
      id: doc.id,
      title: libraryItemTitle(doc.title),
      opened: doc.opened,
      jobId: doc.jobId,
      state: 'saved',
    });
  }
  for (const [id, state] of Object.entries(saveStates)) {
    const doc = snapshots.get(id);
    if (!doc) continue;
    items.set(id, {
      ...items.get(id),
      id,
      title: libraryItemTitle(doc.title),
      opened: doc.opened,
      jobId: doc.jobId,
      state: state.status === 'saved' ? 'saved' : state.status === 'saving' ? 'saving' : 'unsaved',
    });
  }
  for (const job of scanJobs) {
    if (
      job.status !== 'done' ||
      [...items.values()].some(item => item.jobId === job.id || item.id === 'job:' + job.id)
    ) {
      continue;
    }
    const id = 'job:' + job.id;
    items.set(id, {
      id,
      title: job.originalName || '历史扫描',
      opened: new Date(job.createdAt).getTime(),
      jobId: job.id,
      state: 'scan',
      scan: job,
    });
  }
  return [...items.values()].sort((a, b) => b.opened - a.opened);
}
