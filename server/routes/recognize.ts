import express, { type Request } from 'express';
import multer from 'multer';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from '../http-errors.js';
import { displayName } from '../job-files.js';
import { RECOGNITION_REVISION, RETENTION_DAYS, type Job } from '../job-store.js';
import type { JobRouteContext } from './context.js';

const EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg']);
const MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'application/octet-stream']);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

type UploadRequest = Request & { jobId: string };

/** Whether the first bytes of an upload match its (already allow-listed) extension. */
function hasValidSignature(extension: string, header: Buffer): boolean {
  if (extension === '.pdf') return header.subarray(0, 5).equals(Buffer.from('%PDF-'));
  if (extension === '.png') return header.subarray(0, 8).equals(PNG_SIGNATURE);
  return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
}

/**
 * Multipart header parameters use latin1 in Busboy. Recover browser UTF-8 filenames only when the byte
 * round trip is valid, preserving older clients.
 */
function decodeFilename(original: string): string {
  const utf8Name = Buffer.from(original, 'latin1').toString('utf8');
  return Buffer.from(utf8Name, 'utf8').toString('latin1') === original ? utf8Name : original;
}

/** POST /api/recognize: receive one scan, reuse an identical earlier recognition or queue a new one. */
export function createRecognizeRouter(context: JobRouteContext) {
  const { data, maxUploadBytes, engine, store, queue, hooks } = context;
  const router = express.Router();
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => cb(null, path.join(data, (req as UploadRequest).jobId)),
      filename: (_req, file, cb) => cb(null, `input${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: maxUploadBytes, files: 1, fields: 0, parts: 1, fieldNameSize: 32, headerPairs: 50 },
    fileFilter: (_req, file, cb) => {
      if (!EXTENSIONS.has(path.extname(file.originalname).toLowerCase()) || !MIME.has(file.mimetype)) {
        cb(new HttpError(400, '只支持 PDF、PNG 和 JPEG 文件。'));
      } else {
        cb(null, true);
      }
    },
  }).single('file');

  router.post('/api/recognize', async (req, res, next) => {
    let id: string | undefined;
    let reserved = false;
    let cleaned = false;
    async function cleanupUpload() {
      if (cleaned || !id || store.jobs.has(id)) return;
      try {
        const target = await store.directory(id);
        await rm(target, { recursive: true, force: true });
        cleaned = true;
      } catch {
        /* never follow an unsafe cleanup path */
      }
    }
    async function abortIfClosed(): Promise<boolean> {
      if (!queue.closed) return false;
      await cleanupUpload();
      res.status(503).json({ message: '服务正在关闭。' });
      return true;
    }
    try {
      if (await abortIfClosed()) return;
      if (hooks.onHealth) await hooks.onHealth();
      const health = await engine.health();
      if (!health.available) {
        res.status(503).json({ message: health.detail ?? '请运行 npm run setup:omr 安装 Audiveris。', engine: health });
        return;
      }
      if (await abortIfClosed()) return;
      if (queue.isFull()) {
        res.status(429).json({
          message: `本机任务已满，请稍后重试。任务保存 ${RETENTION_DAYS} 天；可在关闭服务后清理 .data/jobs。`,
        });
        return;
      }
      queue.uploading++;
      reserved = true;
      id = randomUUID();
      (req as UploadRequest).jobId = id;
      await mkdir(path.join(data, id), { mode: 0o700 });
      await new Promise<void>((resolve, reject) => {
        upload(req, res, (error: unknown) => (error ? reject(error) : resolve()));
      });
      if (hooks.onUpload) await hooks.onUpload();
      if (await abortIfClosed()) return;
      if (!req.file) {
        await cleanupUpload();
        res.status(400).json({ message: '请选择一个 PDF、PNG 或 JPEG，上传字段名为 file。' });
        return;
      }
      await chmod(req.file.path, 0o600);
      const handle = await open(req.file.path, 'r');
      const header = Buffer.alloc(16);
      try {
        await handle.read(header, 0, 16, 0);
      } finally {
        await handle.close();
      }
      const ext = path.extname(req.file.path);
      if (!hasValidSignature(ext, header)) {
        await cleanupUpload();
        res.status(415).json({ message: '文件内容与格式不符，请上传有效的 PDF、PNG 或 JPEG。' });
        return;
      }
      const name = decodeFilename(req.file.originalname);
      const digest = createHash('sha256')
        .update(await readFile(req.file.path))
        .digest('hex');
      const forced = req.query.force === '1';
      const release = forced
        ? undefined
        : await queue.uploadReservations.reserve(`${RECOGNITION_REVISION}:${ext}:${digest}`);
      try {
        const existing = forced ? undefined : await store.reusableJob(digest, ext);
        if (existing) {
          await cleanupUpload();
          if (await abortIfClosed()) return;
          res.status(202).json({ id: existing.id, status: existing.status, reused: true });
          return;
        }
        if (await abortIfClosed()) return;
        const job: Job = {
          id,
          status: 'queued',
          createdAt: new Date().toISOString(),
          originalName: displayName(name),
          inputBytes: req.file.size,
          inputSha256: digest,
          inputExtension: ext,
          recognitionRevision: RECOGNITION_REVISION,
        };
        await store.persist(job);
        if (await abortIfClosed()) return;
        store.jobs.set(id, job);
        queue.enqueue(id);
        res.status(202).json({ id, status: 'queued' });
        void queue.next();
      } finally {
        release?.();
      }
    } catch (error) {
      await cleanupUpload();
      next(error);
    } finally {
      await cleanupUpload();
      if (reserved) queue.uploading--;
    }
  });

  return router;
}
