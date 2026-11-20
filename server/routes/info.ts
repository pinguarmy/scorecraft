import express from 'express';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import type { RecognitionEngine } from '../engine.js';

/** GET /api/license, /api/source (AGPL corresponding source) and /api/health. */
export function createInfoRouter(options: { root: string; engine: RecognitionEngine; maxUploadBytes: number }) {
  const { root, engine, maxUploadBytes } = options;
  const router = express.Router();

  router.get('/api/license', (_req, res) => {
    // `root` keeps send's dotfile check off the checkout path, which may contain a dot-directory.
    res.type('text/plain').sendFile('LICENSE', { root }, (error) => {
      if (error && !res.headersSent) res.status(503).json({ message: '本地许可证文件尚未提供。' });
    });
  });

  router.get('/api/source', async (_req, res) => {
    const archive = path.join(root, '.data/source.zip');
    try {
      const info = await lstat(archive);
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Missing source archive');
      // With `root`, only 'source.zip' is checked for dot segments, so .data and the checkout path need no
      // dotfiles exemption.
      res.download('source.zip', 'scorecraft-source.zip', { root: path.dirname(archive) }, (error) => {
        if (error && !res.headersSent) res.status(503).json({ message: '源码包暂不可用。' });
      });
    } catch {
      res.status(503).json({ message: '本地源码包尚未生成。请向本机安装维护者获取完整对应源码。' });
    }
  });

  router.get('/api/health', async (_req, res, next) => {
    try {
      res.json({ ok: true, engine: await engine.health(), limits: { maxUploadBytes } });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
