import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import multer from 'multer';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createAudiverisEngine, inspectRecognitionArchive, type RecognitionEngine } from './engine.js';
import { assertPlainPath, displayName, JOB_ID, jobDirectory, openOriginal, originalFile, prepareDataRoot } from './job-files.js';
import { createLibraryRouter } from './library.js';

export type Job = { id: string; status: 'queued' | 'running' | 'done' | 'error'; message?: string; warnings?: string[]; resultUrl?: string; createdAt: string; result?: string; originalName?: string; inputBytes?: number; inputSha256?: string; inputExtension?: string; recognitionRevision?: string; skippedPages?: number[]; sourceJobId?: string; pageCount?: number; recoveryArchive?: string; autoSkippedCover?: true };
export type AppOptions = {
  root: string; dataDir?: string; distDir?: string; engine?: RecognitionEngine;
  maxUploadBytes?: number; maxPendingJobs?: number; maxStoredJobs?: number;
  maxConcurrentRetries?: number;
  _testHooks?: {
    onHealth?: () => Promise<void> | void;
    onUpload?: () => Promise<void> | void;
    onPersist?: (job: Job) => Promise<void> | void;
    onRetryGate?: () => Promise<void> | void;
  };
};
const UUID = JOB_ID;
const EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg']);
const MIME = new Set(['application/pdf', 'image/png', 'image/jpeg', 'application/octet-stream']);
// Bump whenever the engine, OCR model or recognition profile changes. Never reuse
// older recognition settings merely because the upload bytes happen to match.
export const RECOGNITION_REVISION = 'v063-auto-cover';
const SHA256 = /^[0-9a-f]{64}$/;
function publicJob(job: Job) {
  return {
    id: job.id, status: job.status, createdAt: job.createdAt,
    originalName: displayName(job.originalName),
    ...(job.autoSkippedCover === true ? { autoSkippedCover: true } : {}),
    ...(job.skippedPages?.length === 1 && job.skippedPages[0] === 1 ? { skippedPages: [1], pageCount: job.pageCount, ...(job.sourceJobId && UUID.test(job.sourceJobId) ? { sourceJobId: job.sourceJobId } : {}) } : {}),
    ...(typeof job.message === 'string' ? { message: job.message } : {}),
    ...(Array.isArray(job.warnings) ? { warnings: job.warnings.filter((item) => typeof item === 'string').slice(0, 100) } : {}),
    ...(job.status === 'done' && job.result ? { resultUrl: `/api/jobs/${job.id}/score` } : {}),
    ...(Number.isSafeInteger(job.inputBytes) && job.inputBytes! >= 0 ? { inputBytes: job.inputBytes } : {}),
  };
}
function safeMessage(error: unknown): string {
  return (error instanceof Error ? error.message : '识别失败。').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 3000);
}
function loopback(hostname: string): boolean { return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname); }

export async function createApp(options: AppOptions) {
  const root = path.resolve(options.root);
  const prepared = await prepareDataRoot(root, path.resolve(options.dataDir ?? path.join(root, '.data/jobs')));
  const data = prepared.data;
  const canonicalRoot = prepared.root;
  const dist = path.resolve(options.distDir ?? path.join(root, 'dist'));
  const maxUploadBytes = options.maxUploadBytes ?? 20 * 1024 * 1024;
  const maxPending = options.maxPendingJobs ?? 4;
  const maxStored = options.maxStoredJobs ?? 100;
  const maxConcurrentRetries = options.maxConcurrentRetries ?? 2;
  const engine = options.engine ?? createAudiverisEngine({ root });
  await mkdir(data, { recursive: true, mode: 0o700 });
  await chmod(data, 0o700);
  const jobs = new Map<string, Job>();
  const queue: string[] = [];
  const deleting = new Set<string>();
  const readers = new Map<string, number>();
  const uploadReservations = new Map<string, Promise<void>>();
  const retryReservations = new Map<string, Promise<void>>();
  const activeRetryTasks = new Set<string>();
  async function reserveRetry(key: string): Promise<() => void> {
    const previous = retryReservations.get(key);
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    retryReservations.set(key, current);
    await previous;
    return () => {
      if (retryReservations.get(key) === current) retryReservations.delete(key);
      release();
    };
  }
  async function findExistingRetry(source: Job, retryKey: string): Promise<Job | undefined> {
    for (const job of jobs.values()) {
      if (!['queued', 'running', 'done'].includes(job.status) || deleting.has(job.id)) continue;
      if (job.skippedPages?.length === 1 && job.skippedPages[0] === 1) {
        if (job.sourceJobId === source.id || (job.inputSha256 === retryKey && SHA256.test(retryKey))) {
          const reusable = await reusableJob(job.inputSha256 ?? retryKey, '.pdf', job.recognitionRevision);
          if (reusable) return reusable;
        }
      }
    }
    return undefined;
  }
  async function reserveUpload(key: string): Promise<() => void> {
    const previous = uploadReservations.get(key);
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    uploadReservations.set(key, current);
    await previous;
    return () => {
      if (uploadReservations.get(key) === current) uploadReservations.delete(key);
      release();
    };
  }
  async function reusableJob(digest: string, extension: string, revision = RECOGNITION_REVISION): Promise<Job | undefined> {
    for (const job of jobs.values()) {
      if (job.recognitionRevision !== revision || job.inputExtension !== extension || !SHA256.test(job.inputSha256 ?? '') || job.inputSha256 !== digest || deleting.has(job.id) || !['queued', 'running', 'done'].includes(job.status)) continue;
      // Pin the candidate while validating it so deletion cannot race async reads.
      readers.set(job.id, (readers.get(job.id) ?? 0) + 1);
      try {
        const directory = await jobDirectory(canonicalRoot, data, job.id);
        const original = await openOriginal(canonicalRoot, directory);
        if (!original) continue;
        try {
          if (path.extname(original.file) !== extension || original.size <= 0 || original.size > maxUploadBytes || createHash('sha256').update(await original.handle.readFile()).digest('hex') !== digest) continue;
        } finally { await original.handle.close(); }
        if (job.status === 'done') {
          if (typeof job.result !== 'string' || !job.result) continue;
          const requested = path.resolve(directory, job.result);
          await assertPlainPath(canonicalRoot, requested);
          const actual = await realpath(requested);
          const info = await stat(actual);
          if (!actual.startsWith(directory + path.sep) || !/\.(mxl|musicxml|xml)$/i.test(actual) || !info.isFile() || info.size <= 0 || info.size > 32 * 1024 * 1024) continue;
        }
        if (!deleting.has(job.id) && jobs.get(job.id) === job && ['queued', 'running', 'done'].includes(job.status)) return job;
      } catch { /* stale or unsafe candidates are cache misses, never trusted */ }
      finally {
        const count = (readers.get(job.id) ?? 1) - 1;
        if (count) readers.set(job.id, count); else readers.delete(job.id);
      }
    }
    return undefined;
  }
  async function describe(job: Job) {
    const visible = publicJob(job);
    // Engine diagnostics can mention local filenames; expose messages, not host paths.
    const redact = (value: string) => value.split(canonicalRoot).join('[本机项目]').split(root).join('[本机项目]');
    if (visible.message) visible.message = redact(visible.message);
    if (visible.warnings) visible.warnings = visible.warnings.map(redact);
    if (deleting.has(job.id)) return visible;
    try {
      const directory = await jobDirectory(canonicalRoot, data, job.id);
      const original = await originalFile(canonicalRoot, directory);
      if (original && original.size > 0 && original.size <= maxUploadBytes) return { ...visible, inputBytes: visible.inputBytes ?? original.size, originalUrl: `/api/jobs/${job.id}/original` };
    } catch { /* missing or unsafe old input must not prevent reopening the XML */ }
    return visible;
  }
  let running = false;
  let uploading = 0;
  let closed = false;
  const persist = async (job: Job) => {
    if (options._testHooks?.onPersist) await options._testHooks.onPersist(job);
    const directory = await jobDirectory(canonicalRoot, data, job.id);
    const temporary = path.join(directory, 'job.json.tmp');
    try { await assertPlainPath(canonicalRoot, temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await writeFile(temporary, JSON.stringify(job, null, 2), { mode: 0o600 });
    await rename(temporary, path.join(directory, 'job.json'));
  };
  // Do not replay interrupted jobs on startup. Their input stays local for inspection.
  for (const entry of await readdir(data, { withFileTypes: true })) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
    try {
      const directory = await jobDirectory(canonicalRoot, data, entry.name);
      const metadata = path.join(directory, 'job.json');
      await assertPlainPath(canonicalRoot, metadata);
      const stored = JSON.parse(await readFile(metadata, 'utf8')) as Job;
      if (stored.id !== entry.name || !['queued', 'running', 'done', 'error'].includes(stored.status)) continue;
      if (!Number.isFinite(Date.parse(stored.createdAt))) continue;
      if (Date.now() - Date.parse(stored.createdAt) > 7 * 86_400_000) {
        const target = await jobDirectory(canonicalRoot, data, entry.name);
        await rm(target, { recursive: true, force: true });
        continue;
      }
      if (stored.status === 'queued' || stored.status === 'running') {
        stored.status = 'error'; stored.message = '服务已重启，识别任务中断。请重新导入。';
        await persist(stored);
      }
      stored.originalName = displayName(stored.originalName);
      if (!Number.isSafeInteger(stored.inputBytes) || stored.inputBytes! < 0) delete stored.inputBytes;
      jobs.set(stored.id, stored);
    } catch { /* ignore incomplete or invalid metadata, never trust paths from it */ }
  }
  async function next(): Promise<void> {
    if (running || closed) return;
    const id = queue.shift();
    if (!id) return;
    running = true;
    const job = jobs.get(id)!;
    const directory = path.join(data, id);
    try {
      job.status = 'running'; job.message = 'Audiveris 正在本机识别，复杂乐谱可能需要几分钟。';
      await persist(job);
      const input = await originalFile(canonicalRoot, await jobDirectory(canonicalRoot, data, id));
      if (!input) throw new Error('上传文件丢失。请重新导入。');
      let selection: { skipFirstPage: boolean; pageCount?: number; archive?: string } | undefined;
      if (job.skippedPages?.length === 1 && job.skippedPages[0] === 1) {
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
      if (info.isSymbolicLink() || !info.isFile() || !actual.startsWith(base + path.sep) || !/\.(mxl|musicxml|xml)$/i.test(actual) || info.size > 32 * 1024 * 1024 || info.size === 0) throw new Error('识别引擎输出无效。');
      job.status = 'done'; job.message = '识别完成，请对照原谱校对。';
      job.result = path.relative(base, actual);
      job.resultUrl = `/api/jobs/${id}/score`;
      job.warnings = result.warnings;
      if (result.autoSkippedCover && result.skippedPages?.length === 1 && result.skippedPages[0] === 1) {
        job.skippedPages = [1]; job.pageCount = result.pageCount; job.autoSkippedCover = true;
        job.message = '识别完成，已自动跳过未检测到五线谱的第 1 页。完整原稿保留，请校对谱页。';
      }
      if (selection?.skipFirstPage && !job.warnings.some(warning => /跳过/.test(warning))) job.warnings.unshift(`已按你的选择跳过原稿第 1 页，仅处理第 2–${job.pageCount} 页，完整原稿仍保留。`);
    } catch (error) { job.status = 'error'; job.message = safeMessage(error); }
    try { await persist(job); } catch { job.status = 'error'; job.message = '无法保存任务状态，请检查本机磁盘空间和目录权限。'; }
    finally { running = false; void next(); }
  }
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, nextMiddleware) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    let host: URL;
    try { host = new URL(`http://${req.headers.host ?? ''}`); } catch { res.status(403).json({ message: '仅允许本机访问。' }); return; }
    if (!loopback(host.hostname)) { res.status(403).json({ message: '仅允许本机访问。' }); return; }
    if (req.path.startsWith('/api/')) {
      res.setHeader('Cache-Control', 'no-store');
      const origin = req.headers.origin;
      if (origin) {
        let allowed = false;
        try {
          const parsed = new URL(origin);
          allowed = parsed.protocol === 'http:' && loopback(parsed.hostname) && (parsed.host === host.host || parsed.port === '4380');
        } catch { /* reject malformed origin */ }
        if (!allowed) { res.status(403).json({ message: '拒绝其他网站访问本机识谱服务。' }); return; }
      } else if (req.headers['sec-fetch-site'] === 'cross-site') {
        res.status(403).json({ message: '拒绝跨站请求。' }); return;
      }
    }
    nextMiddleware();
  });
  app.get('/api/license', (_req, res) => {
    res.type('text/plain').sendFile(path.join(root, 'LICENSE'), (error) => {
      if (error && !res.headersSent) res.status(503).json({ message: '本地许可证文件尚未提供。' });
    });
  });
  app.get('/api/source', async (_req, res) => {
    const archive = path.join(root, '.data/source.zip');
    try {
      const info = await lstat(archive);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Missing source archive');
      res.download(archive, 'scorecraft-source.zip', { dotfiles: 'allow' }, (error) => {
        if (error && !res.headersSent) res.status(503).json({ message: '源码包暂不可用。' });
      });
    } catch { res.status(503).json({ message: '本地源码包尚未生成。请向本机安装维护者获取完整对应源码。' }); }
  });
  app.use('/api/library', await createLibraryRouter({ root: canonicalRoot }));
  app.get('/api/health', async (_req, res, nextMiddleware) => {
    try { res.json({ ok: true, engine: await engine.health(), limits: { maxUploadBytes } }); }
    catch (error) { nextMiddleware(error); }
  });
  const upload = multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => cb(null, path.join(data, resId(req))),
      filename: (_req, file, cb) => cb(null, `input${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: maxUploadBytes, files: 1, fields: 0, parts: 1, fieldNameSize: 32, headerPairs: 50 },
    fileFilter: (_req, file, cb) => {
      if (!EXTENSIONS.has(path.extname(file.originalname).toLowerCase()) || !MIME.has(file.mimetype)) cb(new Error('只支持 PDF、PNG 和 JPEG 文件。'));
      else cb(null, true);
    },
  }).single('file');
  function resId(req: Request): string { return (req as Request & { jobId: string }).jobId; }
  app.post('/api/recognize', async (req, res, nextMiddleware) => {
    let id: string | undefined;
    let reserved = false;
    let cleaned = false;
    async function cleanupUpload() {
      if (cleaned || !id || jobs.has(id)) return;
      try {
        const target = await jobDirectory(canonicalRoot, data, id);
        await rm(target, { recursive: true, force: true });
        cleaned = true;
      } catch { /* never follow an unsafe cleanup path */ }
    }
    async function abortIfClosed(): Promise<boolean> {
      if (!closed) return false;
      await cleanupUpload();
      res.status(503).json({ message: '服务正在关闭。' });
      return true;
    }
    try {
      if (await abortIfClosed()) return;
      if (options._testHooks?.onHealth) await options._testHooks.onHealth();
      const health = await engine.health();
      if (!health.available) { res.status(503).json({ message: health.detail ?? '请运行 npm run setup:omr 安装 Audiveris。', engine: health }); return; }
      if (await abortIfClosed()) return;
      if (queue.length + Number(running) + uploading >= maxPending || jobs.size + uploading >= maxStored) {
        res.status(429).json({ message: '本机任务已满，请稍后重试。任务保存 7 天；可在关闭服务后清理 .data/jobs。' }); return;
      }
      uploading++; reserved = true;
      id = randomUUID();
      (req as Request & { jobId: string }).jobId = id;
      await mkdir(path.join(data, id), { mode: 0o700 });
      await new Promise<void>((resolve, reject) => upload(req, res, (error: unknown) => error ? reject(error) : resolve()));
      if (options._testHooks?.onUpload) await options._testHooks.onUpload();
      if (await abortIfClosed()) return;
      if (!req.file) { await cleanupUpload(); res.status(400).json({ message: '请选择一个 PDF、PNG 或 JPEG，上传字段名为 file。' }); return; }
      await chmod(req.file.path, 0o600);
      const handle = await open(req.file.path, 'r');
      const header = Buffer.alloc(16);
      try { await handle.read(header, 0, 16, 0); } finally { await handle.close(); }
      const ext = path.extname(req.file.path);
      const valid = ext === '.pdf' ? header.subarray(0, 5).equals(Buffer.from('%PDF-')) : ext === '.png' ? header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
      if (!valid) { await cleanupUpload(); res.status(415).json({ message: '文件内容与格式不符，请上传有效的 PDF、PNG 或 JPEG。' }); return; }
      // Multipart header parameters use latin1 in Busboy. Recover browser UTF-8
      // filenames only when the byte round trip is valid, preserving older clients.
      const utf8Name = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
      const name = Buffer.from(utf8Name, 'utf8').toString('latin1') === req.file.originalname ? utf8Name : req.file.originalname;
      const digest = createHash('sha256').update(await readFile(req.file.path)).digest('hex');
      const forced = req.query.force === '1';
      const release = forced ? undefined : await reserveUpload(`${RECOGNITION_REVISION}:${ext}:${digest}`);
      try {
        const existing = forced ? undefined : await reusableJob(digest, ext);
        if (existing) {
          await cleanupUpload();
          if (await abortIfClosed()) return;
          res.status(202).json({ id: existing.id, status: existing.status, reused: true });
          return;
        }
        if (await abortIfClosed()) return;
        const job: Job = { id, status: 'queued', createdAt: new Date().toISOString(), originalName: displayName(name), inputBytes: req.file.size, inputSha256: digest, inputExtension: ext, recognitionRevision: RECOGNITION_REVISION };
        await persist(job);
        if (await abortIfClosed()) return;
        jobs.set(id, job); queue.push(id);
        res.status(202).json({ id, status: 'queued' });
        void next();
      } finally { release?.(); }
    } catch (error) { await cleanupUpload(); nextMiddleware(error); }
    finally {
      await cleanupUpload();
      if (reserved) uploading--;
    }
  });
  function lookup(req: Request, res: Response): Job | undefined {
    const id = String(req.params.id);
    const job = UUID.test(id) ? jobs.get(id) : undefined;
    if (!job) res.status(404).json({ message: '任务不存在。' });
    return job;
  }
  app.post('/api/jobs/:id/retry', express.json({ limit: '1kb' }), async (req, res, nextMiddleware) => {
    if (closed) { res.status(503).json({ message: '服务正在关闭。' }); return; }
    const source = lookup(req, res);
    if (!source) return;
    if (!req.body || req.body.skipFirstPage !== true || Object.keys(req.body).some(key => key !== 'skipFirstPage')) { res.status(400).json({ message: '请明确确认 skipFirstPage:true，仅跳过第一页。' }); return; }
    if (!['error', 'done'].includes(source.status) || deleting.has(source.id)) { res.status(409).json({ message: '请等待原任务结束后再重试。' }); return; }
    let id: string | undefined;
    let releaseRetryReservation: (() => void) | undefined;
    let acquiredGate = false;
    let reserved = false;
    let cleaned = false;
    const retryKey = (source.inputSha256 && SHA256.test(source.inputSha256)) ? source.inputSha256 : source.id;
    readers.set(source.id, (readers.get(source.id) ?? 0) + 1);

    async function cleanupRetry() {
      if (cleaned || !id || jobs.has(id)) return;
      try {
        const targetDir = await jobDirectory(canonicalRoot, data, id);
        await rm(targetDir, { recursive: true, force: true });
        cleaned = true;
      } catch { /* never remove unsafe paths */ }
    }
    async function abortIfClosed(): Promise<boolean> {
      if (!closed) return false;
      await cleanupRetry();
      res.status(503).json({ message: '服务正在关闭。' });
      return true;
    }

    try {
      releaseRetryReservation = await reserveRetry(retryKey);
      if (await abortIfClosed()) return;

      if (activeRetryTasks.size >= maxConcurrentRetries || queue.length + Number(running) + uploading >= maxPending || jobs.size + uploading >= maxStored) {
        res.status(429).json({ message: '本机任务已满，请稍后重试。' });
        return;
      }
      activeRetryTasks.add(retryKey);
      uploading++;
      acquiredGate = true;
      reserved = true;

      if (options._testHooks?.onRetryGate) await options._testHooks.onRetryGate();

      const existing = await findExistingRetry(source, retryKey);
      if (existing) {
        if (await abortIfClosed()) return;
        res.status(202).json({ id: existing.id, status: existing.status, reused: true, skippedPages: [1], pageCount: existing.pageCount, ...(existing.status === 'done' ? { resultUrl: `/api/jobs/${existing.id}/score` } : {}) });
        return;
      }

      const directory = await jobDirectory(canonicalRoot, data, source.id);
      const original = await openOriginal(canonicalRoot, directory);
      if (!original) { res.status(404).json({ message: '完整原稿不存在，不能重试。' }); return; }
      let bytes: Buffer;
      try {
        if (!original.name.endsWith('.pdf') || original.size > maxUploadBytes || original.size <= 0) { res.status(400).json({ message: '跳过封面重试仅支持有效的多页 PDF。' }); return; }
        bytes = await original.handle.readFile();
      } finally { await original.handle.close(); }
      const archivePath = path.join(directory, 'output/input.omr');
      await assertPlainPath(canonicalRoot, archivePath);
      const archive = await inspectRecognitionArchive(archivePath);
      const revision = `${RECOGNITION_REVISION}:pages=2-${archive.pageCount}`;
      const digest = createHash('sha256').update(bytes).digest('hex');
      const reusable = await reusableJob(digest, '.pdf', revision);
      if (reusable) {
        if (await abortIfClosed()) return;
        res.status(202).json({ id: reusable.id, status: reusable.status, reused: true, skippedPages: [1], pageCount: archive.pageCount, ...(reusable.status === 'done' ? { resultUrl: `/api/jobs/${reusable.id}/score` } : {}) });
        return;
      }
      if (options._testHooks?.onHealth) await options._testHooks.onHealth();
      const health = await engine.health();
      if (!health.available) { res.status(503).json({ message: health.detail ?? '本机识谱引擎不可用。' }); return; }
      if (await abortIfClosed()) return;

      id = randomUUID();
      const target = path.join(data, id);
      await mkdir(target, { mode: 0o700 });
      await writeFile(path.join(target, 'input.pdf'), bytes, { mode: 0o600 });
      const job: Job = { id, status: 'queued', createdAt: new Date().toISOString(), originalName: source.originalName, inputBytes: bytes.length, inputSha256: digest, inputExtension: '.pdf', recognitionRevision: revision, skippedPages: [1], sourceJobId: source.id, pageCount: archive.pageCount };
      if (archive.remainingComplete) {
        // The engine may update an OMR during export. Always copy into the NEW job.
        await assertPlainPath(canonicalRoot, archivePath);
        await writeFile(path.join(target, 'recovery.omr'), await readFile(archivePath), { mode: 0o600 });
        job.recoveryArchive = 'recovery.omr';
      }
      if (await abortIfClosed()) return;
      await persist(job);
      if (await abortIfClosed()) return;
      jobs.set(id, job); queue.push(id);
      res.status(202).json({ id, status: 'queued', skippedPages: [1], pageCount: archive.pageCount });
      void next();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || /档案|页数|符号链接|路径|zip|解压/i.test(safeMessage(error))) res.status(400).json({ message: '无法安全读取原识别档案的页数。请移除封面后重新上传，原任务仍保留。' });
      else nextMiddleware(error);
    } finally {
      if (acquiredGate) {
        activeRetryTasks.delete(retryKey);
      }
      releaseRetryReservation?.();
      if (reserved) uploading--;
      const count = (readers.get(source.id) ?? 1) - 1; if (count) readers.set(source.id, count); else readers.delete(source.id);
      await cleanupRetry();
    }
  });
  app.get('/api/jobs', async (_req, res, nextMiddleware) => {
    try {
      const ordered = [...jobs.values()].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id)).slice(0, maxStored);
      res.json({ jobs: await Promise.all(ordered.map(describe)), retentionDays: 7, maxStoredJobs: maxStored });
    } catch (error) { nextMiddleware(error); }
  });
  app.get('/api/jobs/:id', async (req, res, nextMiddleware) => {
    const job = lookup(req, res);
    if (job) try { res.json(await describe(job)); } catch (error) { nextMiddleware(error); }
  });
  app.get('/api/jobs/:id/original', async (req, res) => {
    const job = lookup(req, res);
    if (!job) return;
    if (deleting.has(job.id)) { res.status(409).json({ message: '任务正在删除，请稍后重试。' }); return; }
    // Keep deletion from racing an open original stream, including async path checks.
    readers.set(job.id, (readers.get(job.id) ?? 0) + 1);
    let released = false;
    const release = () => { if (!released) { released = true; const count = (readers.get(job.id) ?? 1) - 1; if (count) readers.set(job.id, count); else readers.delete(job.id); } };
    res.once('close', release);
    try {
      const directory = await jobDirectory(canonicalRoot, data, job.id);
      const original = await openOriginal(canonicalRoot, directory);
      if (!original) { release(); res.status(404).json({ message: '原始扫描文件不存在，仍可打开已有识别结果。' }); return; }
      if (original.size === 0 || original.size > maxUploadBytes) { await original.handle.close(); release(); res.status(404).json({ message: '原始扫描文件大小无效。' }); return; }
      if (res.destroyed) { await original.handle.close(); release(); return; }
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
      stream.on('error', () => { closeHandle(); if (!res.headersSent) res.status(404).end(); else res.destroy(); }).pipe(res);
    } catch { release(); res.status(404).json({ message: '原始扫描文件不存在或路径不安全。' }); }
  });
  app.delete('/api/jobs/:id', async (req, res) => {
    const job = lookup(req, res);
    if (!job) return;
    if (job.status === 'queued' || job.status === 'running') { res.status(409).json({ message: '正在排队或识别的任务不能删除，请等待识别结束。' }); return; }
    if (deleting.has(job.id) || readers.has(job.id)) { res.status(409).json({ message: '任务正在读取或删除，请稍后重试。' }); return; }
    deleting.add(job.id);
    try {
      const target = await jobDirectory(canonicalRoot, data, job.id);
      // Validate immediately before destructive operation. UUID direct child only.
      if (path.dirname(target) !== data || path.basename(target) !== job.id) throw new Error('Unsafe deletion target');
      await rm(target, { recursive: true, force: false });
      jobs.delete(job.id);
      res.json({ deleted: true, id: job.id });
    } catch { res.status(500).json({ message: '删除失败，任务记录已保留。请检查文件权限或任务目录是否被更改。' }); }
    finally { deleting.delete(job.id); }
  });
  app.get('/api/jobs/:id/score', async (req, res, nextMiddleware) => {
    const job = lookup(req, res);
    if (!job) return;
    if (job.status !== 'done' || !job.result) { res.status(409).json({ message: job.message ?? '识别尚未完成。' }); return; }
    try {
      if (deleting.has(job.id)) { res.status(409).json({ message: '任务正在删除。' }); return; }
      const directory = await jobDirectory(canonicalRoot, data, job.id);
      const requested = path.resolve(directory, job.result);
      await assertPlainPath(canonicalRoot, requested);
      const file = await realpath(requested);
      if (!file.startsWith(directory + path.sep) || !/\.(mxl|musicxml|xml)$/i.test(file)) throw new Error('输出路径无效。');
      const info = await stat(file);
      if (!info.isFile() || info.size > 32 * 1024 * 1024) throw new Error('输出文件无效。');
      const compressed = path.extname(file).toLowerCase() === '.mxl';
      res.type(compressed ? 'application/vnd.recordare.musicxml' : 'application/vnd.recordare.musicxml+xml');
      res.setHeader('Content-Disposition', `inline; filename="score.${compressed ? 'mxl' : 'musicxml'}"`);
      createReadStream(file).on('error', nextMiddleware).pipe(res);
    } catch (error) { nextMiddleware(error); }
  });
  app.use('/api', (_req, res) => { res.status(404).json({ message: '接口不存在。' }); });
  app.use(express.static(dist, { dotfiles: 'deny', index: false }));
  // Serve the source sample in development too; never expose project-root files.
  app.use('/samples', express.static(path.join(root, 'public/samples'), { dotfiles: 'deny' }));
  app.use((req, res, nextMiddleware) => {
    if (req.method !== 'GET' || path.extname(req.path) || req.path.split('/').some((segment) => segment.startsWith('.'))) { res.status(404).json({ message: '文件不存在。' }); return; }
    res.sendFile(path.join(dist, 'index.html'), (error) => {
      if (error && !res.headersSent) res.status(404).send('前端尚未构建。请运行 npm run build，再运行 npm start。');
      else if (error) nextMiddleware(error);
    });
  });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) { res.end(); return; }
    const tooLarge = error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE';
    res.status(tooLarge ? 413 : error instanceof multer.MulterError || /只支持/.test(safeMessage(error)) ? 400 : 500).json({ message: tooLarge ? `文件超过上限 ${Math.round(maxUploadBytes / 1024 / 1024)} MB。` : safeMessage(error) });
  };
  app.use(errors);
  return { app, engine, close: () => { closed = true; }, idle: () => !running && queue.length === 0 && uploading === 0 };
}
