import express from 'express';
import { createReadStream } from 'node:fs';
import { realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertPlainPath, openOriginal } from '../job-files.js';
import { MAX_RESULT_BYTES, RESULT_EXTENSION, RETENTION_DAYS } from '../job-store.js';
import { lookupJob, type JobRouteContext } from './context.js';

/** How long DELETE waits for a reader that has just finished to release the job. */
const PIN_GRACE_MS = 250;

/** Reading and deleting jobs: the list, one job, its original scan and its MusicXML result. */
export function createJobsRouter(context: JobRouteContext) {
  const { canonicalRoot, data, maxUploadBytes, maxStored, store } = context;
  const router = express.Router();

  router.get('/api/jobs', async (_req, res, next) => {
    try {
      const ordered = [...store.jobs.values()]
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id))
        .slice(0, maxStored);
      const jobs = await Promise.all(ordered.map((job) => store.describe(job)));
      res.json({ jobs, retentionDays: RETENTION_DAYS, maxStoredJobs: maxStored });
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/jobs/:id', async (req, res, next) => {
    const job = lookupJob(store, req, res);
    if (!job) return;
    try {
      res.json(await store.describe(job));
    } catch (error) {
      next(error);
    }
  });

  router.get('/api/jobs/:id/original', async (req, res) => {
    const job = lookupJob(store, req, res);
    if (!job) return;
    if (store.deleting.has(job.id)) {
      res.status(409).json({ message: '任务正在删除，请稍后重试。' });
      return;
    }
    // Keep deletion from racing an open original stream, including async path checks.
    store.pin(job.id);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      store.unpin(job.id);
    };
    res.once('close', release);
    try {
      const directory = await store.directory(job.id);
      const original = await openOriginal(canonicalRoot, directory);
      if (!original) {
        release();
        res.status(404).json({ message: '原始扫描文件不存在，仍可打开已有识别结果。' });
        return;
      }
      if (original.size === 0 || original.size > maxUploadBytes) {
        await original.handle.close();
        release();
        res.status(404).json({ message: '原始扫描文件大小无效。' });
        return;
      }
      if (res.destroyed) {
        await original.handle.close();
        release();
        return;
      }
      res.type(original.type);
      res.setHeader('Content-Length', original.size);
      // Never interpolate user metadata into headers. Actual fixed filename is ASCII.
      res.setHeader('Content-Disposition', `inline; filename="${original.name}"`);
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      const stream = original.handle.createReadStream({ autoClose: false });
      let handleClosed = false;
      const closeHandle = () => {
        if (handleClosed) return;
        handleClosed = true;
        stream.destroy();
        void original.handle.close().finally(release);
      };
      res.once('close', closeHandle);
      stream.once('end', closeHandle);
      stream
        .on('error', () => {
          closeHandle();
          if (!res.headersSent) res.status(404).end();
          else res.destroy();
        })
        .pipe(res);
    } catch {
      release();
      res.status(404).json({ message: '原始扫描文件不存在或路径不安全。' });
    }
  });

  router.delete('/api/jobs/:id', async (req, res) => {
    const job = lookupJob(store, req, res);
    if (!job) return;
    if (job.status === 'queued' || job.status === 'running') {
      res.status(409).json({ message: '正在排队或识别的任务不能删除，请等待识别结束。' });
      return;
    }
    // A reader that has just finished is still pinned for a moment; wait briefly before calling it busy.
    await store.whenUnpinned(job.id, PIN_GRACE_MS);
    if (store.jobs.get(job.id) !== job) {
      res.status(404).json({ message: '任务不存在。' });
      return;
    }
    if (store.deleting.has(job.id) || store.isPinned(job.id)) {
      res.status(409).json({ message: '任务正在读取或删除，请稍后重试。' });
      return;
    }
    store.deleting.add(job.id);
    try {
      const target = await store.directory(job.id);
      // Validate immediately before destructive operation. UUID direct child only.
      if (path.dirname(target) !== data || path.basename(target) !== job.id) throw new Error('Unsafe deletion target');
      await rm(target, { recursive: true, force: false });
      store.jobs.delete(job.id);
      res.json({ deleted: true, id: job.id });
    } catch {
      res.status(500).json({ message: '删除失败，任务记录已保留。请检查文件权限或任务目录是否被更改。' });
    } finally {
      store.deleting.delete(job.id);
    }
  });

  router.get('/api/jobs/:id/score', async (req, res, next) => {
    const job = lookupJob(store, req, res);
    if (!job) return;
    if (job.status !== 'done' || !job.result) {
      res.status(409).json({ message: job.message ?? '识别尚未完成。' });
      return;
    }
    try {
      if (store.deleting.has(job.id)) {
        res.status(409).json({ message: '任务正在删除。' });
        return;
      }
      const directory = await store.directory(job.id);
      const requested = path.resolve(directory, job.result);
      await assertPlainPath(canonicalRoot, requested);
      const file = await realpath(requested);
      if (!file.startsWith(directory + path.sep) || !RESULT_EXTENSION.test(file)) throw new Error('输出路径无效。');
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_RESULT_BYTES) throw new Error('输出文件无效。');
      const compressed = path.extname(file).toLowerCase() === '.mxl';
      res.type(compressed ? 'application/vnd.recordare.musicxml' : 'application/vnd.recordare.musicxml+xml');
      res.setHeader('Content-Disposition', `inline; filename="score.${compressed ? 'mxl' : 'musicxml'}"`);
      createReadStream(file).on('error', next).pipe(res);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
