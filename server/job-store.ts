import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertPlainPath, displayName, JOB_ID, jobDirectory, openOriginal, originalFile } from './job-files.js';

export type Job = {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  message?: string;
  warnings?: string[];
  resultUrl?: string;
  createdAt: string;
  result?: string;
  originalName?: string;
  inputBytes?: number;
  inputSha256?: string;
  inputExtension?: string;
  recognitionRevision?: string;
  skippedPages?: number[];
  sourceJobId?: string;
  pageCount?: number;
  recoveryArchive?: string;
  autoSkippedCover?: true;
};

// Bump whenever the engine, OCR model or recognition profile changes. Never reuse
// older recognition settings merely because the upload bytes happen to match.
export const RECOGNITION_REVISION = 'v063-auto-cover';
export const SHA256 = /^[0-9a-f]{64}$/;
export const RETENTION_DAYS = 7;
export const MAX_RESULT_BYTES = 32 * 1024 * 1024;
export const RESULT_EXTENSION = /\.(mxl|musicxml|xml)$/i;
const ACTIVE_OR_DONE: ReadonlyArray<Job['status']> = ['queued', 'running', 'done'];

/** True for a job that skipped exactly the first page (the only page selection the service offers). */
export function skipsCover(job: Job): boolean {
  return job.skippedPages?.length === 1 && job.skippedPages[0] === 1;
}

function publicJob(job: Job) {
  return {
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    originalName: displayName(job.originalName),
    ...(job.autoSkippedCover === true ? { autoSkippedCover: true } : {}),
    ...(skipsCover(job)
      ? {
          skippedPages: [1],
          pageCount: job.pageCount,
          ...(job.sourceJobId && JOB_ID.test(job.sourceJobId) ? { sourceJobId: job.sourceJobId } : {}),
        }
      : {}),
    ...(typeof job.message === 'string' ? { message: job.message } : {}),
    ...(Array.isArray(job.warnings)
      ? { warnings: job.warnings.filter((item) => typeof item === 'string').slice(0, 100) }
      : {}),
    ...(job.status === 'done' && job.result ? { resultUrl: `/api/jobs/${job.id}/score` } : {}),
    ...(Number.isSafeInteger(job.inputBytes) && job.inputBytes! >= 0 ? { inputBytes: job.inputBytes } : {}),
  };
}

export type JobStoreOptions = {
  /** The project root as configured, used only to redact host paths from messages. */
  root: string;
  /** The canonical (realpath) project root that every job path is checked against. */
  canonicalRoot: string;
  /** The jobs directory, a plain directory below `canonicalRoot`. */
  data: string;
  maxUploadBytes: number;
  /** `onPersist` runs at the start of every job.json write. */
  hooks: { readonly onPersist?: (job: Job) => Promise<void> | void };
};

/**
 * The in-memory job table and its on-disk metadata (`<data>/<uuid>/job.json`).
 *
 * `deleting` marks jobs whose directory is being removed; `pin`/`unpin` count readers that have files of a
 * job open, and a pinned job cannot be deleted. Both are checked before every file access so that deletion
 * never races a read.
 */
export class JobStore {
  readonly jobs = new Map<string, Job>();
  readonly deleting = new Set<string>();
  private readonly readers = new Map<string, number>();
  private readonly unpinWaiters = new Map<string, Set<() => void>>();
  private readonly options: JobStoreOptions;

  constructor(options: JobStoreOptions) {
    this.options = options;
  }

  get canonicalRoot(): string {
    return this.options.canonicalRoot;
  }

  get data(): string {
    return this.options.data;
  }

  /** The job's directory, validated as a plain direct child of the jobs directory. */
  directory(id: string): Promise<string> {
    return jobDirectory(this.options.canonicalRoot, this.options.data, id);
  }

  pin(id: string): void {
    this.readers.set(id, (this.readers.get(id) ?? 0) + 1);
  }

  unpin(id: string): void {
    const count = (this.readers.get(id) ?? 1) - 1;
    if (count) {
      this.readers.set(id, count);
      return;
    }
    this.readers.delete(id);
    const waiters = this.unpinWaiters.get(id);
    this.unpinWaiters.delete(id);
    waiters?.forEach((resume) => resume());
  }

  /**
   * Resolves once no reader holds the job, or after `graceMs`, whichever comes first. A reader releases its pin
   * when its response has closed, which is a moment after the client has received the last byte; a client that
   * deletes the job right after reading it would otherwise be told the job is still being read.
   */
  whenUnpinned(id: string, graceMs: number): Promise<void> {
    if (!this.readers.has(id)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.unpinWaiters.get(id) ?? new Set<() => void>();
      this.unpinWaiters.set(id, waiters);
      const resume = () => {
        clearTimeout(timer);
        waiters.delete(resume);
        resolve();
      };
      const timer = setTimeout(resume, graceMs);
      waiters.add(resume);
    });
  }

  isPinned(id: string): boolean {
    return this.readers.has(id);
  }

  async persist(job: Job): Promise<void> {
    const { onPersist } = this.options.hooks;
    if (onPersist) await onPersist(job);
    const { canonicalRoot } = this.options;
    const directory = await this.directory(job.id);
    const temporary = path.join(directory, 'job.json.tmp');
    try {
      await assertPlainPath(canonicalRoot, temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await writeFile(temporary, JSON.stringify(job, null, 2), { mode: 0o600 });
    await rename(temporary, path.join(directory, 'job.json'));
  }

  /**
   * Load stored jobs on startup. Interrupted jobs are not replayed: they are marked as errors and their
   * input stays local for inspection. Jobs past the retention period are removed.
   */
  async load(): Promise<void> {
    const { canonicalRoot, data } = this.options;
    for (const entry of await readdir(data, { withFileTypes: true })) {
      if (!entry.isDirectory() || !JOB_ID.test(entry.name)) continue;
      try {
        const directory = await this.directory(entry.name);
        const metadata = path.join(directory, 'job.json');
        await assertPlainPath(canonicalRoot, metadata);
        const stored = JSON.parse(await readFile(metadata, 'utf8')) as Job;
        if (stored.id !== entry.name || !['queued', 'running', 'done', 'error'].includes(stored.status)) continue;
        if (!Number.isFinite(Date.parse(stored.createdAt))) continue;
        if (Date.now() - Date.parse(stored.createdAt) > RETENTION_DAYS * 86_400_000) {
          const target = await this.directory(entry.name);
          await rm(target, { recursive: true, force: true });
          continue;
        }
        if (stored.status === 'queued' || stored.status === 'running') {
          stored.status = 'error';
          stored.message = '服务已重启，识别任务中断。请重新导入。';
          await this.persist(stored);
        }
        stored.originalName = displayName(stored.originalName);
        if (!Number.isSafeInteger(stored.inputBytes) || stored.inputBytes! < 0) delete stored.inputBytes;
        this.jobs.set(stored.id, stored);
      } catch {
        /* ignore incomplete or invalid metadata, never trust paths from it */
      }
    }
  }

  /**
   * A live job whose stored original still hashes to `digest` (and, when done, whose result is still a
   * plain bounded MusicXML file), recognised with `revision`. Anything stale or unsafe is a cache miss.
   */
  async reusableJob(digest: string, extension: string, revision = RECOGNITION_REVISION): Promise<Job | undefined> {
    const { canonicalRoot, maxUploadBytes } = this.options;
    for (const job of this.jobs.values()) {
      if (
        job.recognitionRevision !== revision ||
        job.inputExtension !== extension ||
        !SHA256.test(job.inputSha256 ?? '') ||
        job.inputSha256 !== digest ||
        this.deleting.has(job.id) ||
        !ACTIVE_OR_DONE.includes(job.status)
      )
        continue;
      // Pin the candidate while validating it so deletion cannot race async reads.
      this.pin(job.id);
      try {
        const directory = await this.directory(job.id);
        const original = await openOriginal(canonicalRoot, directory);
        if (!original) continue;
        try {
          if (
            path.extname(original.file) !== extension ||
            original.size <= 0 ||
            original.size > maxUploadBytes ||
            createHash('sha256')
              .update(await original.handle.readFile())
              .digest('hex') !== digest
          )
            continue;
        } finally {
          await original.handle.close();
        }
        if (job.status === 'done') {
          if (typeof job.result !== 'string' || !job.result) continue;
          const requested = path.resolve(directory, job.result);
          await assertPlainPath(canonicalRoot, requested);
          const actual = await realpath(requested);
          const info = await stat(actual);
          if (
            !actual.startsWith(directory + path.sep) ||
            !RESULT_EXTENSION.test(actual) ||
            !info.isFile() ||
            info.size <= 0 ||
            info.size > MAX_RESULT_BYTES
          )
            continue;
        }
        if (!this.deleting.has(job.id) && this.jobs.get(job.id) === job && ACTIVE_OR_DONE.includes(job.status)) {
          return job;
        }
      } catch {
        /* stale or unsafe candidates are cache misses, never trusted */
      } finally {
        this.unpin(job.id);
      }
    }
    return undefined;
  }

  /** A live skip-cover retry of `source` (or of the same bytes) that can be reused instead of a new job. */
  async findExistingRetry(source: Job, retryKey: string): Promise<Job | undefined> {
    for (const job of this.jobs.values()) {
      if (!ACTIVE_OR_DONE.includes(job.status) || this.deleting.has(job.id)) continue;
      if (skipsCover(job)) {
        if (job.sourceJobId === source.id || (job.inputSha256 === retryKey && SHA256.test(retryKey))) {
          const reusable = await this.reusableJob(job.inputSha256 ?? retryKey, '.pdf', job.recognitionRevision);
          if (reusable) return reusable;
        }
      }
    }
    return undefined;
  }

  /** The client view of a job: no host paths, and an `originalUrl` while the original is still readable. */
  async describe(job: Job) {
    const { root, canonicalRoot, maxUploadBytes } = this.options;
    const visible = publicJob(job);
    // Engine diagnostics can mention local filenames; expose messages, not host paths.
    const redact = (value: string) => value.split(canonicalRoot).join('[本机项目]').split(root).join('[本机项目]');
    if (visible.message) visible.message = redact(visible.message);
    if (visible.warnings) visible.warnings = visible.warnings.map(redact);
    if (this.deleting.has(job.id)) return visible;
    try {
      const directory = await this.directory(job.id);
      const original = await originalFile(canonicalRoot, directory);
      if (original && original.size > 0 && original.size <= maxUploadBytes) {
        return {
          ...visible,
          inputBytes: visible.inputBytes ?? original.size,
          originalUrl: `/api/jobs/${job.id}/original`,
        };
      }
    } catch {
      /* missing or unsafe old input must not prevent reopening the XML */
    }
    return visible;
  }
}
