import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inspectRecognitionArchive, RecognitionArchiveError } from '../engine.js';
import { assertPlainPath, openOriginal, UnsafePathError } from '../job-files.js';
import { RECOGNITION_REVISION, SHA256, type Job } from '../job-store.js';
import { lookupJob, type JobRouteContext } from './context.js';

/**
 * Errors that mean the source job's original or recognition archive cannot be read safely: a missing file,
 * an unsafe path, or an archive that is not a usable Audiveris book. The client gets a 400 with advice to
 * re-upload; anything else is an internal error.
 */
function isUnreadableSource(error: unknown): boolean {
  return (
    (error as NodeJS.ErrnoException).code === 'ENOENT' ||
    error instanceof UnsafePathError ||
    error instanceof RecognitionArchiveError
  );
}

/**
 * POST /api/jobs/:id/retry with `{ "skipFirstPage": true }`: recognise a finished multi-page PDF again
 * without its first page, reusing the archive of the first run where it is complete.
 */
export function createRetryRouter(context: JobRouteContext) {
  const { canonicalRoot, data, maxUploadBytes, engine, store, queue, hooks } = context;
  const router = express.Router();

  router.post('/api/jobs/:id/retry', express.json({ limit: '1kb' }), async (req, res, next) => {
    if (queue.closed) {
      res.status(503).json({ message: '服务正在关闭。' });
      return;
    }
    const source = lookupJob(store, req, res);
    if (!source) return;
    if (!req.body || req.body.skipFirstPage !== true || Object.keys(req.body).some((key) => key !== 'skipFirstPage')) {
      res.status(400).json({ message: '请明确确认 skipFirstPage:true，仅跳过第一页。' });
      return;
    }
    if (!['error', 'done'].includes(source.status) || store.deleting.has(source.id)) {
      res.status(409).json({ message: '请等待原任务结束后再重试。' });
      return;
    }
    let id: string | undefined;
    let releaseRetryReservation: (() => void) | undefined;
    let acquiredGate = false;
    let reserved = false;
    let cleaned = false;
    const retryKey = source.inputSha256 && SHA256.test(source.inputSha256) ? source.inputSha256 : source.id;
    store.pin(source.id);

    async function cleanupRetry() {
      if (cleaned || !id || store.jobs.has(id)) return;
      try {
        const targetDir = await store.directory(id);
        await rm(targetDir, { recursive: true, force: true });
        cleaned = true;
      } catch {
        /* never remove unsafe paths */
      }
    }
    async function abortIfClosed(): Promise<boolean> {
      if (!queue.closed) return false;
      await cleanupRetry();
      res.status(503).json({ message: '服务正在关闭。' });
      return true;
    }

    try {
      releaseRetryReservation = await queue.retryReservations.reserve(retryKey);
      if (await abortIfClosed()) return;

      if (queue.isFullForRetry()) {
        res.status(429).json({ message: '本机任务已满，请稍后重试。' });
        return;
      }
      queue.activeRetries.add(retryKey);
      queue.uploading++;
      acquiredGate = true;
      reserved = true;

      if (hooks.onRetryGate) await hooks.onRetryGate();

      const existing = await store.findExistingRetry(source, retryKey);
      if (existing) {
        if (await abortIfClosed()) return;
        res.status(202).json({
          id: existing.id,
          status: existing.status,
          reused: true,
          skippedPages: [1],
          pageCount: existing.pageCount,
          ...(existing.status === 'done' ? { resultUrl: `/api/jobs/${existing.id}/score` } : {}),
        });
        return;
      }

      const directory = await store.directory(source.id);
      const original = await openOriginal(canonicalRoot, directory);
      if (!original) {
        res.status(404).json({ message: '完整原稿不存在，不能重试。' });
        return;
      }
      const retryable = original.name.endsWith('.pdf') && original.size <= maxUploadBytes && original.size > 0;
      let bytes: Buffer | undefined;
      try {
        if (retryable) bytes = await original.handle.readFile();
      } finally {
        await original.handle.close();
      }
      // Answer only after the handle is closed: the gate below is then released in the same tick as the
      // response, so a client that retries the moment it reads this 400 is not told the queue is full.
      if (!bytes) {
        res.status(400).json({ message: '跳过封面重试仅支持有效的多页 PDF。' });
        return;
      }
      const archivePath = path.join(directory, 'output/input.omr');
      await assertPlainPath(canonicalRoot, archivePath);
      const archive = await inspectRecognitionArchive(archivePath);
      const revision = `${RECOGNITION_REVISION}:pages=2-${archive.pageCount}`;
      const digest = createHash('sha256').update(bytes).digest('hex');
      const reusable = await store.reusableJob(digest, '.pdf', revision);
      if (reusable) {
        if (await abortIfClosed()) return;
        res.status(202).json({
          id: reusable.id,
          status: reusable.status,
          reused: true,
          skippedPages: [1],
          pageCount: archive.pageCount,
          ...(reusable.status === 'done' ? { resultUrl: `/api/jobs/${reusable.id}/score` } : {}),
        });
        return;
      }
      if (hooks.onHealth) await hooks.onHealth();
      const health = await engine.health();
      if (!health.available) {
        res.status(503).json({ message: health.detail ?? '本机识谱引擎不可用。' });
        return;
      }
      if (await abortIfClosed()) return;

      id = randomUUID();
      const target = path.join(data, id);
      await mkdir(target, { mode: 0o700 });
      await writeFile(path.join(target, 'input.pdf'), bytes, { mode: 0o600 });
      const job: Job = {
        id,
        status: 'queued',
        createdAt: new Date().toISOString(),
        originalName: source.originalName,
        inputBytes: bytes.length,
        inputSha256: digest,
        inputExtension: '.pdf',
        recognitionRevision: revision,
        skippedPages: [1],
        sourceJobId: source.id,
        pageCount: archive.pageCount,
      };
      if (archive.remainingComplete) {
        // The engine may update an OMR during export. Always copy into the NEW job.
        await assertPlainPath(canonicalRoot, archivePath);
        await writeFile(path.join(target, 'recovery.omr'), await readFile(archivePath), { mode: 0o600 });
        job.recoveryArchive = 'recovery.omr';
      }
      if (await abortIfClosed()) return;
      await store.persist(job);
      if (await abortIfClosed()) return;
      store.jobs.set(id, job);
      queue.enqueue(id);
      res.status(202).json({ id, status: 'queued', skippedPages: [1], pageCount: archive.pageCount });
      void queue.next();
    } catch (error) {
      if (isUnreadableSource(error)) {
        res.status(400).json({ message: '无法安全读取原识别档案的页数。请移除封面后重新上传，原任务仍保留。' });
      } else {
        next(error);
      }
    } finally {
      if (acquiredGate) {
        queue.activeRetries.delete(retryKey);
      }
      releaseRetryReservation?.();
      if (reserved) queue.uploading--;
      store.unpin(source.id);
      await cleanupRetry();
    }
  });

  return router;
}
