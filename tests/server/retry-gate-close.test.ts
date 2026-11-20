import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { createApp, type Job, type AppOptions } from '../../server/app.js';
import type { RecognitionEngine } from '../../server/engine.js';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);

function form(bytes = PNG, name = 'score.png') {
  const data = new FormData();
  data.set('file', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), name);
  return data;
}

function deferred() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

function makeArchive(pages = 3) {
  const sheets = Array.from(
    { length: pages },
    (_, i) => `<sheet number="${i + 1}"><steps>LOAD PAGE</steps></sheet>`,
  ).join('');
  return zipSync({ 'book.xml': strToU8(`<book>${sheets}</book>`) });
}

async function writeJobSeed(
  dataDir: string,
  id: string,
  meta: Partial<Job> = {},
  pdfBytes = Buffer.from('%PDF-original-test'),
  archiveBytes = makeArchive(3),
) {
  const dir = path.join(dataDir, id);
  await mkdir(path.join(dir, 'output'), { recursive: true });
  await writeFile(path.join(dir, 'input.pdf'), pdfBytes);
  await writeFile(path.join(dir, 'output/input.omr'), archiveBytes);
  const fullMeta: Job = {
    id,
    status: 'error',
    createdAt: new Date().toISOString(),
    originalName: 'source.pdf',
    inputBytes: pdfBytes.length,
    inputExtension: '.pdf',
    ...meta,
  };
  await writeFile(path.join(dir, 'job.json'), JSON.stringify(fullMeta, null, 2));
}

async function settle(base: string, id: string) {
  for (let i = 0; i < 100; i++) {
    const job = await fetch(`${base}/api/jobs/${id}`).then((r) => r.json());
    if (job.status === 'done' || job.status === 'error') return job;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Job did not settle');
}

async function createServerFixture(options: Partial<AppOptions> = {}, seedFn?: (dataDir: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scorecraft-gate-close-'));
  const dataDir = path.join(root, '.data/jobs');
  await mkdir(dataDir, { recursive: true });
  if (seedFn) {
    await seedFn(dataDir);
  }
  const engine: RecognitionEngine = options.engine ?? {
    health: async () => ({ available: true, name: 'Audiveris' }),
    recognize: async (_input, output) => {
      await mkdir(output, { recursive: true });
      const file = path.join(output, 'score.musicxml');
      await writeFile(file, '<score-partwise/>');
      return { file, warnings: [] };
    },
  };
  const instance = await createApp({ root, dataDir, engine, ...options });
  const server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    root,
    dataDir,
    base,
    instance,
    engine,
    async close() {
      instance.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      assert(root.startsWith(path.join(os.tmpdir(), 'scorecraft-gate-close-')));
      for (let i = 0; i < 50; i++) {
        try {
          await rm(root, { recursive: true, force: true });
          break;
        } catch (e) {
          if (i === 49) throw e;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
    },
  };
}

test('recognize: closing during health check returns 503 and cleans up directory', async () => {
  const gate = deferred();
  const f = await createServerFixture({
    _testHooks: {
      onHealth: async () => {
        await gate.wait;
      },
    },
  });
  try {
    const uploadPromise = fetch(`${f.base}/api/recognize`, { method: 'POST', body: form() });
    f.instance.close();
    gate.release();
    const response = await uploadPromise;
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.message, '服务正在关闭。');
    const entries = await readdir(f.dataDir);
    assert.deepEqual(entries, []);
  } finally {
    gate.release();
    await f.close();
  }
});

test('recognize: closing during upload returns 503 and cleans up directory', async () => {
  const gate = deferred();
  const f = await createServerFixture({
    _testHooks: {
      onUpload: async () => {
        await gate.wait;
      },
    },
  });
  try {
    const uploadPromise = fetch(`${f.base}/api/recognize`, { method: 'POST', body: form() });
    f.instance.close();
    gate.release();
    const response = await uploadPromise;
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.message, '服务正在关闭。');
    const entries = await readdir(f.dataDir);
    assert.deepEqual(entries, []);
  } finally {
    gate.release();
    await f.close();
  }
});

test('recognize: closing during persist returns 503 and cleans up directory without enqueueing', async () => {
  const gate = deferred();
  let persistCount = 0;
  const f = await createServerFixture({
    _testHooks: {
      onPersist: async () => {
        persistCount++;
        await gate.wait;
      },
    },
  });
  try {
    const uploadPromise = fetch(`${f.base}/api/recognize`, { method: 'POST', body: form() });
    for (let i = 0; i < 50 && persistCount === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(persistCount, 1);
    f.instance.close();
    gate.release();
    const response = await uploadPromise;
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.message, '服务正在关闭。');
    const entries = await readdir(f.dataDir);
    assert.deepEqual(entries, []);
    assert.equal(f.instance.idle(), true);
  } finally {
    gate.release();
    await f.close();
  }
});

test('retry: closing during persist returns 503, cleans up new directory and keeps original', async () => {
  const gate = deferred();
  const sourceId = '11111111-2222-4333-8444-555555555555';
  let persistCount = 0;
  const f = await createServerFixture(
    {
      _testHooks: {
        onPersist: async () => {
          persistCount++;
          await gate.wait;
        },
      },
    },
    async (dataDir) => {
      await writeJobSeed(dataDir, sourceId);
    },
  );
  try {
    const retryPromise = fetch(`${f.base}/api/jobs/${sourceId}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipFirstPage: true }),
    });
    for (let i = 0; i < 50 && persistCount === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(persistCount, 1);
    f.instance.close();
    gate.release();
    const response = await retryPromise;
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.message, '服务正在关闭。');
    const entries = await readdir(f.dataDir);
    assert.deepEqual(entries, [sourceId]);
  } finally {
    gate.release();
    await f.close();
  }
});

test('retry: global bounded gate throttles different tasks concurrently and allows subsequent retry', async () => {
  const gate = deferred();
  const id1 = 'aaaaaaaa-1111-4111-8111-111111111111';
  const id2 = 'bbbbbbbb-2222-4222-8222-222222222222';
  let task1EnteredGate = false;
  const f = await createServerFixture(
    {
      maxConcurrentRetries: 1,
      _testHooks: {
        onRetryGate: async () => {
          if (!task1EnteredGate) {
            task1EnteredGate = true;
            await gate.wait;
          }
        },
      },
    },
    async (dataDir) => {
      await writeJobSeed(dataDir, id1, {}, Buffer.from('%PDF-input-1'));
      await writeJobSeed(dataDir, id2, {}, Buffer.from('%PDF-input-2'));
    },
  );
  try {
    const task1Promise = fetch(`${f.base}/api/jobs/${id1}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipFirstPage: true }),
    });

    for (let i = 0; i < 50 && !task1EnteredGate; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(task1EnteredGate, true);

    const task2Response = await fetch(`${f.base}/api/jobs/${id2}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipFirstPage: true }),
    });
    assert.equal(task2Response.status, 429);
    const task2Body = await task2Response.json();
    assert.match(task2Body.message, /本机任务已满/);

    gate.release();
    const task1Response = await task1Promise;
    assert.equal(task1Response.status, 202);
    const task1Body = await task1Response.json();
    await settle(f.base, task1Body.id);

    const task2RetryAfter = await fetch(`${f.base}/api/jobs/${id2}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipFirstPage: true }),
    });
    assert.equal(task2RetryAfter.status, 202);
    const task2BodySuccess = await task2RetryAfter.json();
    await settle(f.base, task2BodySuccess.id);
  } finally {
    gate.release();
    await f.close();
  }
});

test('retry: same-task concurrent requests preserve deduplication under gate', async () => {
  const gate = deferred();
  const id = 'cccccccc-3333-4333-8333-333333333333';
  let entered = 0;
  const f = await createServerFixture(
    {
      maxConcurrentRetries: 1,
      _testHooks: {
        onRetryGate: async () => {
          entered++;
          await gate.wait;
        },
      },
    },
    async (dataDir) => {
      await writeJobSeed(dataDir, id);
    },
  );
  try {
    const [p1, p2] = [
      fetch(`${f.base}/api/jobs/${id}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skipFirstPage: true }),
      }),
      fetch(`${f.base}/api/jobs/${id}/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skipFirstPage: true }),
      }),
    ];

    for (let i = 0; i < 50 && entered === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(entered, 1);
    gate.release();

    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.status, 202);
    assert.equal(r2.status, 202);
    const b1 = await r1.json();
    const b2 = await r2.json();
    assert.equal(b1.id, b2.id);
    await settle(f.base, b1.id);
    while (!f.instance.idle()) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    gate.release();
    await f.close();
  }
});

test('retry: oversized PDF (> maxUploadBytes) returns 400 and releases gate in finally', async () => {
  const id = 'dddddddd-4444-4444-8444-444444444444';
  const validId = 'eeeeeeee-5555-4555-8555-555555555555';
  const bigPdf = Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(100)]);
  const f = await createServerFixture(
    {
      maxUploadBytes: 50,
      maxConcurrentRetries: 1,
    },
    async (dataDir) => {
      await writeJobSeed(dataDir, id, {}, bigPdf);
      await writeJobSeed(dataDir, validId, {}, Buffer.from('%PDF-small'));
    },
  );
  try {
    const resBig = await fetch(`${f.base}/api/jobs/${id}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipFirstPage: true }),
    });
    assert.equal(resBig.status, 400);
    const bodyBig = await resBig.json();
    assert.match(bodyBig.message, /跳过封面重试仅支持有效的多页 PDF/);

    const resValid = await fetch(`${f.base}/api/jobs/${validId}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipFirstPage: true }),
    });
    assert.equal(resValid.status, 202);
    const bodyValid = await resValid.json();
    await settle(f.base, bodyValid.id);
  } finally {
    await f.close();
  }
});

test('retry: corrupt/missing archive returns 400 and releases gate in finally', async () => {
  const corruptId = 'ffffffff-6666-4666-8666-666666666666';
  const validId = '00000000-7777-4777-8777-777777777777';
  const f = await createServerFixture(
    {
      maxConcurrentRetries: 1,
    },
    async (dataDir) => {
      await writeJobSeed(dataDir, corruptId, {}, Buffer.from('%PDF-test'), Buffer.from('corrupt not zip'));
      await writeJobSeed(dataDir, validId);
    },
  );
  try {
    const resCorrupt = await fetch(`${f.base}/api/jobs/${corruptId}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipFirstPage: true }),
    });
    assert.equal(resCorrupt.status, 400);
    assert.match((await resCorrupt.json()).message, /无法安全读取原识别档案/);

    const resValid = await fetch(`${f.base}/api/jobs/${validId}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipFirstPage: true }),
    });
    assert.equal(resValid.status, 202);
    const bodyValid = await resValid.json();
    await settle(f.base, bodyValid.id);
  } finally {
    await f.close();
  }
});

test('retry: existing/reuse path is also bounded by concurrency limit before findExistingRetry reads', async () => {
  const gate = deferred();
  const idA = '12345678-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const idC = '87654321-cccc-4ccc-8ccc-cccccccccccc';
  let blockGate = false;
  let taskCEnteredGate = false;
  const f = await createServerFixture(
    {
      maxConcurrentRetries: 1,
      _testHooks: {
        onRetryGate: async () => {
          if (blockGate) {
            taskCEnteredGate = true;
            await gate.wait;
          }
        },
      },
    },
    async (dataDir) => {
      await writeJobSeed(dataDir, idA, {}, Buffer.from('%PDF-input-A'));
      await writeJobSeed(dataDir, idC, {}, Buffer.from('%PDF-input-C'));
    },
  );
  try {
    // 1. Retry A initially to produce an existing/reusable retry job
    const initialRetryA = await fetch(`${f.base}/api/jobs/${idA}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipFirstPage: true }),
    });
    assert.equal(initialRetryA.status, 202);
    const initialBodyA = await initialRetryA.json();
    assert.equal(initialBodyA.reused, undefined);
    await settle(f.base, initialBodyA.id);

    // 2. Start retry for task C, which holds the gate
    blockGate = true;
    const taskCPromise = fetch(`${f.base}/api/jobs/${idC}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipFirstPage: true }),
    });

    for (let i = 0; i < 50 && !taskCEnteredGate; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(taskCEnteredGate, true);

    // 3. Task A retries. Even though it has a reusable existing retry job,
    // the global retry gate check comes BEFORE findExistingRetry, so it must return 429!
    const taskARetryWhileBlocked = await fetch(`${f.base}/api/jobs/${idA}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipFirstPage: true }),
    });
    assert.equal(taskARetryWhileBlocked.status, 429);
    const body429 = await taskARetryWhileBlocked.json();
    assert.match(body429.message, /本机任务已满/);

    // 4. Release task C's gate
    gate.release();
    const taskCResponse = await taskCPromise;
    assert.equal(taskCResponse.status, 202);
    const taskCBody = await taskCResponse.json();
    await settle(f.base, taskCBody.id);

    // 5. With gate free, retry A again. It enters the gate, runs findExistingRetry, and returns 202 with reused: true!
    const taskARetryAfter = await fetch(`${f.base}/api/jobs/${idA}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skipFirstPage: true }),
    });
    assert.equal(taskARetryAfter.status, 202);
    const bodyReused = await taskARetryAfter.json();
    assert.equal(bodyReused.id, initialBodyA.id);
    assert.equal(bodyReused.reused, true);
    await settle(f.base, bodyReused.id);
    while (!f.instance.idle()) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } finally {
    gate.release();
    await f.close();
  }
});
