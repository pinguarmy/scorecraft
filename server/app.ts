import express from 'express';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createAudiverisEngine, type RecognitionEngine } from './engine.js';
import { createErrorHandler } from './http-errors.js';
import { prepareDataRoot } from './job-files.js';
import { JobStore } from './job-store.js';
import { createLibraryRouter } from './library.js';
import { RecognitionQueue } from './recognition-queue.js';
import { requestGuard } from './request-guard.js';
import type { JobRouteContext, TestHooks } from './routes/context.js';
import { createInfoRouter } from './routes/info.js';
import { createJobsRouter } from './routes/jobs.js';
import { createRecognizeRouter } from './routes/recognize.js';
import { createRetryRouter } from './routes/retry.js';
import { createStaticRouter } from './static-files.js';

export { RECOGNITION_REVISION, type Job } from './job-store.js';

export type AppOptions = {
  root: string;
  /** Where scan jobs are kept. Defaults to `<root>/.data/jobs`; must be inside the project directory. */
  dataDir?: string;
  /** Where saved scores are kept. Defaults to `<root>/.data/library`; must be inside the project directory. */
  libraryDir?: string;
  distDir?: string;
  engine?: RecognitionEngine;
  maxUploadBytes?: number;
  maxPendingJobs?: number;
  maxStoredJobs?: number;
  maxConcurrentRetries?: number;
  _testHooks?: TestHooks;
};

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
  // Look the hooks up at each use, so they behave exactly as when they were read from `options` inline.
  const hooks: TestHooks = {
    get onHealth() {
      return options._testHooks?.onHealth;
    },
    get onUpload() {
      return options._testHooks?.onUpload;
    },
    get onPersist() {
      return options._testHooks?.onPersist;
    },
    get onRetryGate() {
      return options._testHooks?.onRetryGate;
    },
  };
  const engine = options.engine ?? createAudiverisEngine({ root });
  await mkdir(data, { recursive: true, mode: 0o700 });
  await chmod(data, 0o700);

  const store = new JobStore({ root, canonicalRoot, data, maxUploadBytes, hooks });
  await store.load();
  const queue = new RecognitionQueue({ store, engine, maxPending, maxStored, maxConcurrentRetries });
  const jobs: JobRouteContext = { canonicalRoot, data, maxUploadBytes, maxStored, engine, store, queue, hooks };

  const app = express();
  app.disable('x-powered-by');
  app.use(requestGuard());
  app.use(createInfoRouter({ root, engine, maxUploadBytes }));
  app.use(
    '/api/library',
    await createLibraryRouter({
      root: canonicalRoot,
      ...(options.libraryDir ? { dataDir: path.resolve(canonicalRoot, path.relative(root, path.resolve(options.libraryDir))) } : {}),
    }),
  );
  app.use(createRecognizeRouter(jobs));
  app.use(createRetryRouter(jobs));
  app.use(createJobsRouter(jobs));
  app.use('/api', (_req, res) => {
    res.status(404).json({ message: '接口不存在。' });
  });
  app.use(createStaticRouter({ root, dist }));
  app.use(createErrorHandler({ maxUploadBytes }));

  return {
    app,
    engine,
    close: () => queue.close(),
    idle: () => queue.idle(),
  };
}
