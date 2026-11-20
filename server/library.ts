import express, { type ErrorRequestHandler } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, open, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isValidDocId, sanitizeSession, UUID_RE, type RecentDocument } from '../src/practice/session.js';
import { assertPlainPath, prepareDataRoot } from './job-files.js';

const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_JSON_BYTES = 10 * 1024 * 1024;
type SavedDocument = RecentDocument & { updatedAt: number; xmlBytes: number };
class InvalidDocument extends Error {}
class LibraryStatusError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function text(value: unknown, maximum: number, fallback = ''): string {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value))
    throw new InvalidDocument('曲目信息过长或含无效字符。');
  return value;
}
function sanitizeSaved(raw: unknown, id: string): RecentDocument {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidDocument('请提供完整曲目。');
  const item = raw as Record<string, unknown>;
  if (!isValidDocId(item.id) || item.id.trim().toLowerCase() !== id)
    throw new InvalidDocument('曲目编号与请求不一致。');
  if (typeof item.xml !== 'string' || !item.xml.trim()) throw new InvalidDocument('乐谱 XML 不能为空。');
  if (Buffer.byteLength(item.xml, 'utf8') > MAX_XML_BYTES) throw new InvalidDocument('乐谱 XML 超过 8 MiB 保存上限。');
  if (/<!DOCTYPE|<!ENTITY/i.test(item.xml)) throw new InvalidDocument('不能保存含 DTD 或实体声明的 XML。');
  if (typeof item.opened !== 'number' || !Number.isFinite(item.opened) || item.opened < 0 || item.opened > 8.64e15)
    throw new InvalidDocument('打开时间无效。');
  const session =
    item.session && typeof item.session === 'object' && !Array.isArray(item.session)
      ? (item.session as Record<string, unknown>)
      : {};
  if (Buffer.byteLength(JSON.stringify(session), 'utf8') > 64 * 1024) throw new InvalidDocument('练习设置过大。');
  const ids = new Set<string>();
  const addId = (value: unknown) => {
    if (
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 200 &&
      !/[\u0000-\u001f]/.test(value) &&
      ids.size < 512
    )
      ids.add(value);
  };
  if (Array.isArray(session.muted)) session.muted.slice(0, 512).forEach(addId);
  addId(session.solo);
  if (session.partInstruments && typeof session.partInstruments === 'object' && !Array.isArray(session.partInstruments))
    Object.keys(session.partInstruments).slice(0, 512).forEach(addId);
  // Hydration has no parsed score yet. Preserve bounded settings, then the client
  // re-sanitizes against actual score bounds after opening. Never parse/execute XML here.
  const cleanSession = sanitizeSession(session, {
    tempo: 88,
    totalBeats: 1e9,
    measureCount: 100_000,
    partIds: [...ids],
  });
  const title = text(item.title, 200, '未命名乐谱');
  const composer = text(item.composer, 200);
  const source = text(item.source, 1024);
  if (item.jobId !== undefined && (typeof item.jobId !== 'string' || !UUID_RE.test(item.jobId)))
    throw new InvalidDocument('扫描任务编号无效。');
  return {
    id,
    title,
    composer,
    source,
    opened: item.opened,
    xml: item.xml,
    session: cleanSession,
    ...(typeof item.jobId === 'string' ? { jobId: item.jobId.toLowerCase() } : {}),
  };
}
function metadata(document: SavedDocument) {
  const { id, title, composer, source, jobId, opened, updatedAt, xmlBytes } = document;
  return { id, title, composer, source, ...(jobId ? { jobId } : {}), opened, updatedAt, xmlBytes };
}
export async function createLibraryRouter(options: { root: string; dataDir?: string }) {
  const prepared = await prepareDataRoot(
    path.resolve(options.root),
    path.resolve(options.dataDir ?? path.join(path.resolve(options.root), '.data/library')),
  );
  const { root, data } = prepared;
  await chmod(data, 0o700);
  const router = express.Router();
  const writes = new Map<string, Promise<unknown>>();
  const filename = (id: string) => path.join(data, `${createHash('sha256').update(id).digest('hex')}.json`);
  async function readSaved(file: string): Promise<SavedDocument> {
    await assertPlainPath(root, file);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_JSON_BYTES) throw new InvalidDocument('本地曲目文件无效。');
      const raw = JSON.parse(await handle.readFile('utf8')) as Record<string, unknown>;
      if (!isValidDocId(raw.id)) throw new InvalidDocument('本地曲目编号无效。');
      const id = raw.id.trim().toLowerCase();
      if (file !== filename(id)) throw new InvalidDocument('本地曲目文件名不匹配。');
      const clean = sanitizeSaved(raw, id);
      if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt))
        throw new InvalidDocument('本地曲目时间无效。');
      return { ...clean, updatedAt: raw.updatedAt, xmlBytes: Buffer.byteLength(clean.xml, 'utf8') };
    } finally {
      await handle.close();
    }
  }
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.get('/', async (_req, res, next) => {
    try {
      await assertPlainPath(root, data);
      const documents: ReturnType<typeof metadata>[] = [];
      for (const entry of await readdir(data, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
        try {
          documents.push(metadata(await readSaved(path.join(data, entry.name))));
        } catch {
          /* damaged/unsafe files are not exposed */
        }
      }
      documents.sort((a, b) => b.opened - a.opened || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
      res.json({ documents });
    } catch (error) {
      next(error);
    }
  });
  router.get('/:id', async (req, res, next) => {
    if (!isValidDocId(req.params.id)) {
      res.status(400).json({ message: '曲目编号无效。' });
      return;
    }
    try {
      const document = await readSaved(filename(req.params.id.trim().toLowerCase()));
      res.setHeader('ETag', `"${document.updatedAt}"`);
      res.json(document);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') res.status(404).json({ message: '已保存曲目不存在。' });
      else next(error);
    }
  });
  router.put('/:id', express.json({ limit: MAX_JSON_BYTES, strict: true }), saveRequest);
  router.patch('/:id/session', express.json({ limit: 128 * 1024, strict: true }), saveRequest);
  async function saveRequest(req: express.Request, res: express.Response, next: express.NextFunction) {
    if (!isValidDocId(req.params.id)) {
      res.status(400).json({ message: '曲目编号无效。' });
      return;
    }
    const id = String(req.params.id).trim().toLowerCase();
    const patch = req.method === 'PATCH';
    const ifMatchHeader = req.headers['if-match'];
    try {
      const fullDocument = patch ? undefined : sanitizeSaved(req.body, id);
      if (
        patch &&
        (!req.body ||
          typeof req.body !== 'object' ||
          Array.isArray(req.body) ||
          !Object.hasOwn(req.body, 'session') ||
          !Object.hasOwn(req.body, 'opened') ||
          Object.keys(req.body).some((key) => key !== 'session' && key !== 'opened'))
      )
        throw new InvalidDocument('请提供 session 和 opened。');
      const previous = writes.get(id) ?? Promise.resolve();
      const pending = previous
        .catch(() => {})
        .then(async () => {
          await assertPlainPath(root, data);
          const target = filename(id);
          let exists = false;
          try {
            await assertPlainPath(root, target);
            if (!(await lstat(target)).isFile()) throw new InvalidDocument('目标不是曲目文件。');
            exists = true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
          if (patch && !exists) throw new LibraryStatusError(404, '已保存曲目不存在，请先保存完整乐谱。');
          if (!patch && req.query.createOnly === '1' && exists)
            throw new LibraryStatusError(409, '曲目已经保存，迁移不会覆盖本机版本。');
          let existing: SavedDocument | undefined;
          if (exists) {
            existing = await readSaved(target);
            if (ifMatchHeader !== undefined) {
              const expected = ifMatchHeader.replace(/["\s]/g, '');
              if (expected && expected !== '*' && String(existing.updatedAt) !== expected) {
                throw new LibraryStatusError(
                  409,
                  patch
                    ? '练习设置版本冲突：已被其他窗口更新，未覆盖较新内容。'
                    : '乐谱版本冲突：已被其他窗口更新，未覆盖较新版本。',
                );
              }
            }
          }
          const document = patch
            ? sanitizeSaved({ ...existing!, session: req.body.session, opened: req.body.opened }, id)
            : fullDocument!;
          const nextUpdatedAt = existing ? Math.max(Date.now(), existing.updatedAt + 1) : Date.now();
          const saved: SavedDocument = {
            ...document,
            updatedAt: nextUpdatedAt,
            xmlBytes: Buffer.byteLength(document.xml, 'utf8'),
          };
          const temporary = path.join(data, `.${path.basename(target)}.${randomUUID()}.tmp`);
          try {
            await writeFile(temporary, JSON.stringify(saved), { flag: 'wx', mode: 0o600 });
            await assertPlainPath(root, data);
            try {
              await assertPlainPath(root, target);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
            await rename(temporary, target);
          } finally {
            // The exact generated temporary child is the only cleanup target.
            if (path.dirname(temporary) === data)
              try {
                await assertPlainPath(root, temporary);
                await rm(temporary, { force: true });
              } catch {
                /* absent or unsafe: leave untouched */
              }
          }
          return { id, updatedAt: saved.updatedAt, xmlBytes: saved.xmlBytes };
        });
      writes.set(id, pending);
      try {
        const receipt = await pending;
        res.setHeader('ETag', `"${receipt.updatedAt}"`);
        res.json(receipt);
      } finally {
        if (writes.get(id) === pending) writes.delete(id);
      }
    } catch (error) {
      next(error);
    }
  }
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    const status = (error as { status?: number }).status;
    res
      .status(
        error instanceof LibraryStatusError
          ? error.status
          : status === 413
            ? 413
            : error instanceof InvalidDocument || status === 400
              ? 400
              : 500,
      )
      .json({
        message:
          error instanceof LibraryStatusError
            ? error.message
            : status === 413
              ? '保存请求超过大小上限。完整曲目最多 10 MiB，练习设置最多 128 KiB。'
              : error instanceof InvalidDocument
                ? error.message
                : status === 400
                  ? '保存请求不是有效 JSON。'
                  : '无法读写本机曲目库，请检查目录权限；原曲目不会被清除。',
      });
  };
  router.use(errors);
  return router;
}
