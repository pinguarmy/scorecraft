import type { Request, Response } from 'express';
import type { RecognitionEngine } from '../engine.js';
import { JOB_ID } from '../job-files.js';
import type { Job, JobStore } from '../job-store.js';
import type { RecognitionQueue } from '../recognition-queue.js';

/** Test-only hooks. Each runs at a fixed point so tests can hold a request there and race it. */
export type TestHooks = {
  /** Before the engine health check of an upload or a retry. */
  onHealth?: () => Promise<void> | void;
  /** After multer has stored an upload, before it is validated. */
  onUpload?: () => Promise<void> | void;
  /** At the start of every job.json write. */
  onPersist?: (job: Job) => Promise<void> | void;
  /** After a retry has taken its concurrency slot, before it looks for a reusable job. */
  onRetryGate?: () => Promise<void> | void;
};

/** Everything the job routes share. */
export type JobRouteContext = {
  canonicalRoot: string;
  data: string;
  maxUploadBytes: number;
  maxStored: number;
  engine: RecognitionEngine;
  store: JobStore;
  queue: RecognitionQueue;
  hooks: TestHooks;
};

/** The job named by `:id`, or undefined after sending 404. */
export function lookupJob(store: JobStore, req: Request, res: Response): Job | undefined {
  const id = String(req.params.id);
  const job = JOB_ID.test(id) ? store.jobs.get(id) : undefined;
  if (!job) res.status(404).json({ message: '任务不存在。' });
  return job;
}
