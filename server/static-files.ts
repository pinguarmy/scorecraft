import express, { type Response } from 'express';
import path from 'node:path';

/** Vite's content-hashed build output (`assets/<name>-<hash>.<ext>`): a changed file gets a new URL. */
export const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
/** The HTML document must be revalidated on every load so it always points at the current hashed assets. */
export const DOCUMENT_CACHE = 'no-cache';
/**
 * Files with stable names (instrument samples under /audio, demo scores under /samples): reused for an hour
 * without a request, then revalidated by ETag (a 304 when unchanged). An hour saves the ~100 sample
 * revalidations on every reload during a practice session, yet a user who upgrades the app gets changed
 * samples within the hour at the latest.
 */
export const UNHASHED_CACHE = 'public, max-age=3600';

/**
 * Defence in depth for the app document, which renders untrusted MusicXML (OSMD draws it as inline SVG) and
 * shows the user's original scans. Scripts and requests stay same-origin; inline styles are needed by React
 * and OSMD; blob: URLs carry downloads and the local preview of an original scan (an <img> or a PDF in an
 * <object>); original scans from the archive are same-origin /api URLs.
 */
export const DOCUMENT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "media-src 'self' blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'self' blob:",
  "frame-src 'self' blob:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const HASHED_ASSET = /^assets\/(?:[^/]+\/)*[^/]+-[A-Za-z0-9_-]{8}\.[A-Za-z0-9.]+$/;

function setDocumentHeaders(res: Response): void {
  res.setHeader('Cache-Control', DOCUMENT_CACHE);
  res.setHeader('Content-Security-Policy', DOCUMENT_CSP);
}

/**
 * The built front end: files from `dist/`, the sample scores (also from `public/samples` so they work before a
 * build), and `index.html` for every other extensionless GET so client-side routes load the app. Mount it
 * after the API routes.
 */
export function createStaticRouter(options: { root: string; dist: string }) {
  const { root, dist } = options;
  const router = express.Router();

  router.use(express.static(dist, {
    dotfiles: 'deny',
    index: false,
    setHeaders: (res, file) => {
      const relative = path.relative(dist, file).split(path.sep).join('/');
      if (relative === 'index.html') setDocumentHeaders(res);
      else if (HASHED_ASSET.test(relative)) res.setHeader('Cache-Control', IMMUTABLE_CACHE);
      else res.setHeader('Cache-Control', UNHASHED_CACHE);
    },
  }));
  // Serve the source sample in development too; never expose project-root files.
  router.use('/samples', express.static(path.join(root, 'public/samples'), {
    dotfiles: 'deny',
    setHeaders: (res) => res.setHeader('Cache-Control', UNHASHED_CACHE),
  }));
  router.use((req, res, next) => {
    if (req.method !== 'GET' || path.extname(req.path) || req.path.split('/').some((segment) => segment.startsWith('.'))) {
      res.status(404).json({ message: '文件不存在。' });
      return;
    }
    setDocumentHeaders(res);
    // Resolve against `root` so only the requested name is checked for dot segments, not the checkout path
    // (which may itself sit below a dot-directory, such as ~/.local/src/scorecraft).
    res.sendFile('index.html', { root: dist }, (error) => {
      if (error && !res.headersSent) res.status(404).send('前端尚未构建。请运行 npm run build，再运行 npm start。');
      else if (error) next(error);
    });
  });

  return router;
}
