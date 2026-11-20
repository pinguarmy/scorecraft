import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { strToU8, zipSync } from 'fflate';
import { createApp } from '../../server/app.js';
import type { RecognitionEngine } from '../../server/engine.js';
import { createErrorHandler, HttpError } from '../../server/http-errors.js';

const UNREADABLE_ARCHIVE = /无法安全读取原识别档案的页数/;

const engine: RecognitionEngine = {
  health: async () => ({ available: true, name: 'Audiveris' }),
  recognize: async () => {
    throw new Error('Not used');
  },
};

function archive(pages: number) {
  const sheets = Array.from({ length: pages }, (_, index) => `<sheet number="${index + 1}"><steps>PAGE</steps></sheet>`);
  return zipSync({ 'book.xml': strToU8(`<book>${sheets.join('')}</book>`) });
}

async function fixture(seed: (dataDir: string) => Promise<void>, recognitionEngine = engine) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scorecraft-status-'));
  const dataDir = path.join(root, '.data/jobs');
  await mkdir(dataDir, { recursive: true });
  await seed(dataDir);
  const instance = await createApp({ root, dataDir, engine: recognitionEngine });
  const server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    base: `http://127.0.0.1:${address.port}`,
    async close() {
      instance.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      assert(root.startsWith(path.join(os.tmpdir(), 'scorecraft-status-')));
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** A finished PDF job whose recognition archive is `archiveBytes`, or absent when undefined. */
async function seedJob(dataDir: string, id: string, archiveBytes?: Uint8Array) {
  const directory = path.join(dataDir, id);
  await mkdir(path.join(directory, 'output'), { recursive: true });
  await writeFile(path.join(directory, 'input.pdf'), '%PDF-status-test');
  if (archiveBytes) await writeFile(path.join(directory, 'output/input.omr'), archiveBytes);
  const job = { id, status: 'error', createdAt: new Date().toISOString(), originalName: 'source.pdf', inputExtension: '.pdf' };
  await writeFile(path.join(directory, 'job.json'), JSON.stringify(job));
}

function retry(base: string, id: string) {
  return fetch(`${base}/api/jobs/${id}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skipFirstPage: true }),
  });
}

test('HttpError carries its own status; other errors stay 500 with their sanitised message', async () => {
  const handler = createErrorHandler({ maxUploadBytes: 1024 * 1024 });
  const sent: Array<{ status: number; body: unknown }> = [];
  function response() {
    const res = {
      headersSent: false,
      statusCode: 200,
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(body: unknown) {
        sent.push({ status: res.statusCode, body });
        return res;
      },
    };
    return res;
  }
  const call = (error: unknown) => handler(error, {} as never, response() as never, () => {});
  call(new HttpError(400, '只支持 PDF、PNG 和 JPEG 文件。'));
  call(new HttpError(409, 'conflict'));
  // Wording no longer decides the status: a plain Error mentioning 只支持 is an internal error.
  call(new Error('只支持\u0007 something'));
  call('not an error');
  assert.deepEqual(sent, [
    { status: 400, body: { message: '只支持 PDF、PNG 和 JPEG 文件。' } },
    { status: 409, body: { message: 'conflict' } },
    { status: 500, body: { message: '只支持 something' } },
    { status: 500, body: { message: '识别失败。' } },
  ]);
});

test('retry answers 400 for a missing, non-ZIP, incomplete or single-page source archive', async () => {
  const ids = {
    missing: '10000000-0000-4000-8000-000000000001',
    notZip: '10000000-0000-4000-8000-000000000002',
    noBook: '10000000-0000-4000-8000-000000000003',
    onePage: '10000000-0000-4000-8000-000000000004',
  };
  const f = await fixture(async (dataDir) => {
    await seedJob(dataDir, ids.missing);
    await seedJob(dataDir, ids.notZip, strToU8('plainly not a zip archive'));
    await seedJob(dataDir, ids.noBook, zipSync({ 'other.xml': strToU8('<x/>') }));
    await seedJob(dataDir, ids.onePage, archive(1));
  });
  try {
    for (const id of Object.values(ids)) {
      const response = await retry(f.base, id);
      assert.equal(response.status, 400, id);
      assert.match((await response.json()).message, UNREADABLE_ARCHIVE);
    }
    const listed = await fetch(`${f.base}/api/jobs`).then((response) => response.json());
    assert.equal(listed.jobs.length, Object.keys(ids).length, 'no retry job is created');
  } finally {
    await f.close();
  }
});

test('retry reports an unexpected failure as a 500 even when its wording mentions a path', async () => {
  const id = '20000000-0000-4000-8000-000000000001';
  const failing: RecognitionEngine = {
    ...engine,
    health: async () => {
      throw new Error('引擎配置路径损坏');
    },
  };
  const f = await fixture(async (dataDir) => seedJob(dataDir, id, archive(3)), failing);
  try {
    const response = await retry(f.base, id);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { message: '引擎配置路径损坏' });
  } finally {
    await f.close();
  }
});
