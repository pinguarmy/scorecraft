import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { inspectRecognitionArchive, type RecognitionEngine } from './engine.js';
import { safeMessage } from './http-errors.js';
import { assertPlainPath, originalFile } from './job-files.js';
import { MAX_RESULT_BYTES, RESULT_EXTENSION, skipsCover, type JobStore } from './job-store.js';

/**
 * Serialises work per key: `reserve(key)` waits for the previous holder of the same key to release, then
 * returns this holder's release function. Used so two requests for the same input cannot both miss the
 * dedup lookup and start duplicate recognitions.
 */
export class KeyedReservations {
  private readonly holders = new Map<string, Promise<void>>();

  async reserve(key: string): Promise<() => void> {
    const previous = this.holders.get(key);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.holders.set(key, current);
    await previous;
    return () => {
      if (this.holders.get(key) === current) this.holders.delete(key);
      release();
    };
  }
}

export type RecognitionQueueOptions = {
  store: JobStore;
  engine: RecognitionEngine;
  maxPending: number;
  maxStored: number;
  maxConcurrentRetries: number;
};

/**
 * Admission control and the single-worker recognition queue.
 *
 * `uploading` counts requests that hold a slot while their input is being received or prepared but not yet
 * queued; it counts against both limits so a burst cannot overshoot them. `activeRetries` holds the retry
 * keys currently being prepared, bounded by `maxConcurrentRetries`. Once `close()` is called no further job
 * is started, and the routes refuse new work.
 */
export class RecognitionQueue {
  readonly pending: string[] = [];
  readonly uploadReservations = new KeyedReservations();
  readonly retryReservations = new KeyedReservations();
  readonly activeRetries = new Set<string>();
  uploading = 0;
  private running = false;
  private closedFlag = false;
  private readonly options: RecognitionQueueOptions;

  constructor(options: RecognitionQueueOptions) {
    this.options = options;
  }

  get closed(): boolean {
    return this.closedFlag;
  }

  close(): void {
    this.closedFlag = true;
  }

  idle(): boolean {
    return !this.running && this.pending.length === 0 && this.uploading === 0;
  }

  /** No room for another job: too many queued or in flight, or too many stored. */
  isFull(): boolean {
    const { maxPending, maxStored, store } = this.options;
    return (
      this.pending.length + Number(this.running) + this.uploading >= maxPending ||
      store.jobs.size + this.uploading >= maxStored
    );
  }

  /** No room for another retry: as `isFull`, or too many retries being prepared already. */
  isFullForRetry(): boolean {
    return this.activeRetries.size >= this.options.maxConcurrentRetries || this.isFull();
  }

  /** Queue a job that is already persisted and in the store. Call `next()` to start the worker. */
  enqueue(id: string): void {
    this.pending.push(id);
  }

  /** Start the next queued job unless one is running or the queue is closed; chains to the following job. */
  async next(): Promise<void> {
    if (this.running || this.closedFlag) return;
    const id = this.pending.shift();
    if (!id) return;
    this.running = true;
    const { store, engine } = this.options;
    const { canonicalRoot, data } = store;
    const job = store.jobs.get(id)!;
    const directory = path.join(data, id);
    try {
      job.status = 'running';
      job.message = 'Audiveris 正在本机识别，复杂乐谱可能需要几分钟。';
      await store.persist(job);
      const input = await originalFile(canonicalRoot, await store.directory(id));
      if (!input) throw new Error('上传文件丢失。请重新导入。');
      let selection: { skipFirstPage: boolean; pageCount?: number; archive?: string } | undefined;
      if (skipsCover(job)) {
        selection = { skipFirstPage: true, pageCount: job.pageCount };
        if (job.recoveryArchive === 'recovery.omr') {
          const archive = path.join(directory, 'recovery.omr');
          await assertPlainPath(canonicalRoot, archive);
          if ((await inspectRecognitionArchive(archive)).remainingComplete) selection.archive = archive;
        }
      }
      const result = await engine.recognize(input.file, path.join(directory, 'output'), selection);
      const base = await realpath(directory);
      const actual = await realpath(result.file);
      const info = await lstat(result.file);
      if (
        info.isSymbolicLink() ||
        !info.isFile() ||
        !actual.startsWith(base + path.sep) ||
        !RESULT_EXTENSION.test(actual) ||
        info.size > MAX_RESULT_BYTES ||
        info.size === 0
      )
        throw new Error('识别引擎输出无效。');
      job.status = 'done';
      job.message = '识别完成，请对照原谱校对。';
      job.result = path.relative(base, actual);
      job.resultUrl = `/api/jobs/${id}/score`;
      job.warnings = result.warnings;
      if (result.autoSkippedCover && result.skippedPages?.length === 1 && result.skippedPages[0] === 1) {
        job.skippedPages = [1];
        job.pageCount = result.pageCount;
        job.autoSkippedCover = true;
        job.message = '识别完成，已自动跳过未检测到五线谱的第 1 页。完整原稿保留，请校对谱页。';
      }
      if (selection?.skipFirstPage && !job.warnings.some((warning) => /跳过/.test(warning))) {
        job.warnings.unshift(`已按你的选择跳过原稿第 1 页，仅处理第 2–${job.pageCount} 页，完整原稿仍保留。`);
      }
    } catch (error) {
      job.status = 'error';
      job.message = safeMessage(error);
    }
    try {
      await store.persist(job);
    } catch {
      job.status = 'error';
      job.message = '无法保存任务状态，请检查本机磁盘空间和目录权限。';
    } finally {
      this.running = false;
      void this.next();
    }
  }
}
