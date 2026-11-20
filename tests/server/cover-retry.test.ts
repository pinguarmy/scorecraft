import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { createApp } from '../../server/app';
import { createAudiverisEngine, inspectRecognitionArchive, type RecognitionEngine } from '../../server/engine';
const ID = '11111111-1111-4111-8111-111111111111';
function archive(complete = true) {
  return zipSync({
    'book.xml': strToU8(
      `<book><sheet number="1" invalid="true"><steps>LOAD BINARY</steps></sheet><sheet number="2"><steps>LOAD ${complete ? 'PAGE' : 'GRID'}</steps></sheet><sheet number="3"><steps>LOAD PAGE</steps></sheet></book>`,
    ),
  });
}
async function setup(complete = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scorecraft-cover-'));
  const directory = path.join(root, '.data/jobs', ID);
  await mkdir(path.join(directory, 'output'), { recursive: true });
  const metadata = { id: ID, status: 'error', createdAt: new Date().toISOString(), originalName: 'private-test.pdf' };
  await writeFile(path.join(directory, 'input.pdf'), '%PDF-test-original');
  await writeFile(path.join(directory, 'job.json'), JSON.stringify(metadata));
  await writeFile(path.join(directory, 'output/input.omr'), archive(complete));
  const calls: unknown[] = [];
  const engine: RecognitionEngine = {
    health: async () => ({ available: true, name: 'Audiveris' }),
    recognize: async (_input, output, options) => {
      calls.push(options);
      await mkdir(output, { recursive: true });
      const file = path.join(output, 'score.musicxml');
      await writeFile(file, '<score-partwise/>');
      return { file, warnings: [] };
    },
  };
  const instance = await createApp({ root, engine });
  const server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    root,
    directory,
    calls,
    base,
    async close() {
      instance.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      assert(root.startsWith(path.join(os.tmpdir(), 'scorecraft-cover-')));
      await rm(root, { recursive: true, force: true });
    },
  };
}
async function retry(base: string, body: unknown = { skipFirstPage: true }, headers = {}) {
  return fetch(`${base}/api/jobs/${ID}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
async function settle(base: string, id: string) {
  for (let i = 0; i < 100; i++) {
    const job = await fetch(`${base}/api/jobs/${id}`).then((r) => r.json());
    if (job.status === 'done' || job.status === 'error') return job;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Job did not settle');
}
test('explicit cover retry creates a separate labelled job, copies originals and deduplicates only same page profile', async () => {
  const f = await setup();
  try {
    const originalMeta = await readFile(path.join(f.directory, 'job.json'), 'utf8');
    const originalArchive = await readFile(path.join(f.directory, 'output/input.omr'));
    const responses = await Promise.all([retry(f.base), retry(f.base)]);
    assert(responses.every((r) => r.status === 202));
    const first = await responses[0].json();
    const second = await responses[1].json();
    assert.equal(first.id, second.id);
    assert.notEqual(first.id, ID);
    const job = await settle(f.base, first.id);
    assert.equal(job.status, 'done');
    assert.deepEqual(job.skippedPages, [1]);
    assert.equal(job.pageCount, 3);
    assert.equal(job.sourceJobId, ID);
    assert(job.warnings.some((w: string) => /跳过/.test(w)));
    assert.equal(f.calls.length, 1);
    const selection = f.calls[0] as { skipFirstPage: boolean; pageCount: number; archive?: string };
    assert.equal(selection.skipFirstPage, true);
    assert.equal(selection.pageCount, 3);
    assert(selection.archive?.includes(first.id));
    assert.equal(await readFile(path.join(f.directory, 'job.json'), 'utf8'), originalMeta);
    assert.deepEqual(await readFile(path.join(f.directory, 'output/input.omr')), originalArchive);
    assert.equal(await readFile(path.join(f.root, '.data/jobs', first.id, 'input.pdf'), 'utf8'), '%PDF-test-original');
    const upload = new FormData();
    upload.set('file', new Blob(['%PDF-test-original'], { type: 'application/pdf' }), 'again.pdf');
    const ordinary = await fetch(`${f.base}/api/recognize`, { method: 'POST', body: upload }).then((r) => r.json());
    assert.notEqual(ordinary.id, first.id, 'all-pages profile never reuses skip-cover result');
    await settle(f.base, ordinary.id);
  } finally {
    await f.close();
  }
});
test('incomplete saved pages select explicit remaining pages for recognition, and confirmation/origin are required', async () => {
  const f = await setup(false);
  try {
    assert.equal((await retry(f.base, { skipFirstPage: false })).status, 400);
    assert.equal((await retry(f.base, { skipFirstPage: true, pages: [2] })).status, 400);
    assert.equal((await retry(f.base, { skipFirstPage: true }, { Origin: 'https://evil.example' })).status, 403);
    const response = await retry(f.base);
    const { id } = await response.json();
    await settle(f.base, id);
    assert.deepEqual(f.calls[0], { skipFirstPage: true, pageCount: 3 });
  } finally {
    await f.close();
  }
});
test('unsafe original archive symlink is refused without creating or modifying jobs', async () => {
  const f = await setup();
  try {
    const target = path.resolve(f.directory, 'output/input.omr');
    assert.equal(path.dirname(target), path.join(f.directory, 'output'));
    await rm(target);
    const outside = path.join(f.root, 'outside.omr');
    await writeFile(outside, archive());
    await symlink(outside, target);
    assert.equal((await retry(f.base)).status, 400);
    assert.equal(f.calls.length, 0);
    assert.equal((await fetch(`${f.base}/api/jobs`).then((r) => r.json())).jobs.length, 1);
  } finally {
    await f.close();
  }
});
test('engine archive export passes exact bounded sheets and never transcribes saved complete pages', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scorecraft-cover-cli-'));
  const output = path.join(root, 'output');
  await mkdir(output);
  const bin = path.join(root, 'fake-engine');
  await writeFile(bin, '#!/bin/sh\nprintf "%s\\n" "$@" > args.txt\nexit 0\n', { mode: 0o755 });
  try {
    await writeFile(path.join(output, 'score.musicxml'), '<score-partwise/>');
    const saved = path.join(root, 'saved.omr');
    await writeFile(saved, archive());
    assert.deepEqual(await inspectRecognitionArchive(saved), { pageCount: 3, remainingComplete: true });
    await createAudiverisEngine({ root, bin }).recognize(path.join(root, 'input.pdf'), output, {
      skipFirstPage: true,
      pageCount: 3,
      archive: saved,
    });
    const args = await readFile(path.join(root, 'args.txt'), 'utf8');
    assert.match(args, /-sheets\n2-3\n/);
    assert.doesNotMatch(args, /-transcribe/);
    assert(args.endsWith(path.join(output, 'recovery.omr') + '\n'));
    await assert.rejects(
      createAudiverisEngine({ root, bin }).recognize('', output, { skipFirstPage: true, pageCount: 1 }),
      /页数/,
    );
  } finally {
    assert(root.startsWith(path.join(os.tmpdir(), 'scorecraft-cover-cli-')));
    await rm(root, { recursive: true, force: true });
  }
});
