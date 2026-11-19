import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp, type Job } from '../../server/app.js';
import type { Server } from 'node:http';
import { displayName } from '../../server/job-files.js';
import type { RecognitionEngine } from '../../server/engine.js';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);
const engine: RecognitionEngine = { health: async () => ({ name: 'Audiveris', available: true }), recognize: async (_input, output) => {
  await mkdir(output, { recursive: true }); const file = path.join(output, 'score.xml'); await writeFile(file, '<score-partwise/>'); return { file, warnings: [] };
} };
async function fixture(seed?: (root: string, data: string) => Promise<void>, customEngine = engine) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scorecraft-library-'));
  const data = path.join(root, '.data/jobs'); await mkdir(data, { recursive: true });
  await seed?.(root, data);
  const instance = await createApp({ root, engine: customEngine });
  const server = instance.app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  return { root, data, base: `http://127.0.0.1:${address.port}`, async close() {
    instance.close(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    assert(root.startsWith(path.join(os.tmpdir(), 'scorecraft-library-'))); await rm(root, { recursive: true, force: true });
  } };
}
async function seedJob(data: string, id: string, values: Partial<Job> = {}, input?: string) {
  const dir = path.join(data, id); await mkdir(path.join(dir, 'output'), { recursive: true });
  await writeFile(path.join(dir, 'output/score.xml'), '<score-partwise/>');
  await writeFile(path.join(dir, 'job.json'), JSON.stringify({ id, status: 'done', createdAt: new Date().toISOString(), result: 'output/score.xml', ...values }));
  if (input) await writeFile(path.join(dir, input), PNG);
}
async function done(base: string, id: string) {
  for (let i = 0; i < 100; i++) {
    const job = await fetch(`${base}/api/jobs/${id}`).then((r) => r.json());
    if (job.status === 'done' || job.status === 'error') return job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Job did not settle');
}
test('list is newest first, allowlisted, canonical URLs, bounded and backwards compatible', async () => {
  const f = await fixture(async (_root, data) => {
    await seedJob(data, A, { createdAt: new Date(Date.now() - 1000).toISOString() }, 'input.jpeg');
    await seedJob(data, B, { originalName: '../../bad\nname.pdf', resultUrl: 'https://evil.example/steal', message: `读取失败 ${_root}/.data/jobs/private` });
    const metadata = JSON.parse(await readFile(path.join(data, B, 'job.json'), 'utf8')); metadata.secretPath = '/etc/passwd';
    await writeFile(path.join(data, B, 'job.json'), JSON.stringify(metadata));
  });
  try {
    const response = await fetch(`${f.base}/api/jobs`); assert.equal(response.headers.get('cache-control'), 'no-store');
    const list = await response.json(); assert.equal(list.retentionDays, 7); assert.equal(list.maxStoredJobs, 100);
    assert.deepEqual(list.jobs.map((j: Job) => j.id), [B, A]);
    assert.equal(list.jobs[0].originalName, 'badname.pdf'); assert.equal(list.jobs[0].originalUrl, undefined);
    assert(!list.jobs[0].message.includes(f.root));
    assert.equal(list.jobs[0].resultUrl, `/api/jobs/${B}/score`);
    assert.equal(list.jobs[1].originalName, '历史扫描'); assert.equal(list.jobs[1].inputBytes, PNG.length);
    for (const job of list.jobs) { assert.equal(job.result, undefined); assert.equal(job.secretPath, undefined); assert(Number.isFinite(Date.parse(job.createdAt))); }
    assert.equal((await fetch(`${f.base}/api/jobs/${B}/original`)).status, 404);
    assert.equal(await fetch(`${f.base}/api/jobs/${B}/score`).then((r) => r.text()), '<score-partwise/>');
    const original = await fetch(`${f.base}/api/jobs/${A}/original`);
    assert.equal(original.status, 200); assert.match(original.headers.get('content-type')!, /image\/jpeg/);
    assert.equal(original.headers.get('content-disposition'), 'inline; filename="input.jpeg"');
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), PNG);
  } finally { await f.close(); }
});
test('upload persists sanitized basename and bytes and original reopens after restart metadata loading', async () => {
  assert.equal(displayName('C:\\private\\bad\u0000\r\nname.png'), 'badname.png');
  assert.equal(Array.from(displayName('🎼'.repeat(300))).length, 200);
  const f = await fixture();
  let restoredServer: Server | undefined;
  let closeRestored: (() => void) | undefined;
  try {
    const form = new FormData(); form.set('file', new Blob([PNG], { type: 'image/png' }), '../小步舞曲.png');
    const response = await fetch(`${f.base}/api/recognize`, { method: 'POST', body: form }); assert.equal(response.status, 202);
    const { id } = await response.json(); const job = await done(f.base, id);
    assert.equal(job.originalName, '小步舞曲.png'); assert.equal(job.inputBytes, PNG.length); assert.equal(job.originalUrl, `/api/jobs/${id}/original`);
    const stored = JSON.parse(await readFile(path.join(f.data, id, 'job.json'), 'utf8'));
    assert.equal(stored.originalName, '小步舞曲.png'); assert.equal(stored.inputBytes, PNG.length);
    const restored = await createApp({ root: f.root, engine }); closeRestored = restored.close;
    restoredServer = restored.app.listen(0, '127.0.0.1'); await once(restoredServer, 'listening');
    const address = restoredServer.address(); assert(address && typeof address !== 'string');
    const restoredBase = `http://127.0.0.1:${address.port}`;
    const loaded = await fetch(`${restoredBase}/api/jobs/${id}`).then((r) => r.json()); assert.equal(loaded.originalName, '小步舞曲.png');
    const original = await fetch(`${restoredBase}${loaded.originalUrl}`); assert.equal(original.status, 200); await original.arrayBuffer();
  } finally {
    closeRestored?.(); if (restoredServer) { restoredServer.closeAllConnections(); await new Promise<void>((resolve) => restoredServer!.close(() => resolve())); }
    await f.close();
  }
});
test('terminal delete is race guarded and job original score become 404', async () => {
  const f = await fixture(async (_root, data) => seedJob(data, A, {}, 'input.png'));
  try {
    const responses = await Promise.all([0, 1].map(() => fetch(`${f.base}/api/jobs/${A}`, { method: 'DELETE' })));
    assert.equal(responses.filter((r) => r.status === 200).length, 1);
    assert(responses.every((r) => [200, 404, 409].includes(r.status)));
    for (const suffix of ['', '/original', '/score']) assert.equal((await fetch(`${f.base}/api/jobs/${A}${suffix}`)).status, 404);
    assert.deepEqual((await fetch(`${f.base}/api/jobs`).then((r) => r.json())).jobs, []);
  } finally { await f.close(); }
});
test('queued and running jobs reject deletion and hostile origins cannot delete terminal jobs', async () => {
  let release!: () => void; const wait = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture(async (_root, data) => seedJob(data, A), { ...engine, recognize: async () => { await wait; throw new Error('test stop'); } });
  const ids: string[] = [];
  try {
    for (let i = 0; i < 2; i++) { const form = new FormData(); form.set('file', new Blob([PNG], { type: 'image/png' }), 'scan.png'); ids.push((await fetch(`${f.base}/api/recognize`, { method: 'POST', body: form }).then((r) => r.json())).id); }
    for (const id of ids) assert.equal((await fetch(`${f.base}/api/jobs/${id}`, { method: 'DELETE' })).status, 409);
    assert.equal((await fetch(`${f.base}/api/jobs/${A}`, { method: 'DELETE', headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await fetch(`${f.base}/api/jobs/${A}/original`, { headers: { Origin: 'https://evil.example' } })).status, 403);
    for (const id of ['..%2F..', 'not-a-uuid', `${A}%2F..`]) assert.equal((await fetch(`${f.base}/api/jobs/${id}`, { method: 'DELETE' })).status, 404);
  } finally { release(); for (const id of ids) await done(f.base, id); await f.close(); }
});
test('symlink original and swapped job target are refused, failure keeps metadata and external data', async () => {
  const f = await fixture(async (_root, data) => seedJob(data, A));
  try {
    const outside = path.join(f.root, 'outside'); await mkdir(outside); await writeFile(path.join(outside, 'input.png'), 'private content');
    const dir = path.join(f.data, A);
    await symlink(path.join(outside, 'input.png'), path.join(dir, 'input.png'));
    assert.equal((await fetch(`${f.base}/api/jobs/${A}/original`)).status, 404);
    await rename(dir, path.join(f.data, `${A}-backup`));
    await symlink(outside, dir);
    assert.equal((await fetch(`${f.base}/api/jobs/${A}`, { method: 'DELETE' })).status, 500);
    assert.equal((await fetch(`${f.base}/api/jobs/${A}`)).status, 200);
    assert.equal(await readFile(path.join(outside, 'input.png'), 'utf8'), 'private content');
    assert.equal((await fetch(`${f.base}/api/jobs/${A}/original`)).status, 404);
    assert.equal((await fetch(`${f.base}/api/jobs/${A}/score`)).status, 500);
  } finally { await f.close(); }
});
test('data-root symlink ancestor swap cannot redirect deletion and initial symlink is rejected', async () => {
  const f = await fixture(async (_root, data) => seedJob(data, A));
  try {
    const outside = path.join(f.root, 'external'); await mkdir(outside); await seedJob(outside, A, {}, 'input.png');
    await rename(path.join(f.root, '.data'), path.join(f.root, '.data-backup'));
    await mkdir(path.join(f.root, '.data')); await symlink(outside, path.join(f.root, '.data/jobs'));
    assert.equal((await fetch(`${f.base}/api/jobs/${A}`, { method: 'DELETE' })).status, 500);
    assert.equal(await readFile(path.join(outside, A, 'input.png')).then((b) => b.length), PNG.length);
    await assert.rejects(createApp({ root: f.root, engine }), /符号链接/);
  } finally { await f.close(); }
});
