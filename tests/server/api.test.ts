import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/app.js';
import { createAudiverisEngine, findResult, runProcess, type RecognitionEngine } from '../../server/engine.js';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
function form(bytes = PNG, name = 'score.png', mime = 'image/png') {
  const data = new FormData(); data.set('file', new Blob([new Uint8Array(bytes)], { type: mime }), name); return data;
}
async function fixture(engine?: RecognitionEngine, extra: Record<string, number> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scorecraft-server-'));
  const dataDir = path.join(root, '.data/jobs');
  const dist = path.join(root, 'dist');
  await mkdir(dist, { recursive: true });
  await writeFile(path.join(dist, 'index.html'), '<html>practice</html>');
  await writeFile(path.join(dist, 'bundle.js'), 'console.log("practice")');
  await writeFile(path.join(root, 'LICENSE'), 'AGPL test license');
  const instance = await createApp({ root, dataDir, engine, ...extra });
  const server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  return { root, base, dataDir, instance, async close() {
    instance.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    assert(root.startsWith(path.join(os.tmpdir(), 'scorecraft-server-')));
    await rm(root, { recursive: true, force: true });
  } };
}
const available = { available: true, name: 'Audiveris', version: 'test-double' } as const;
function fakeEngine(action?: RecognitionEngine['recognize']): RecognitionEngine {
  return { health: async () => available, recognize: action ?? (async (_input, output) => {
    await mkdir(output, { recursive: true });
    const file = path.join(output, 'score.musicxml');
    await writeFile(file, '<?xml version="1.0"?><score-partwise/>');
    return { file, warnings: ['Test double output, not optical recognition.'] };
  }) };
}
async function settled(base: string, id: string) {
  for (let i = 0; i < 100; i++) {
    const job = await fetch(`${base}/api/jobs/${id}`).then((response) => response.json());
    if (job.status === 'done' || job.status === 'error') return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Test job did not settle');
}

test('missing engine is honest and actionable, never falls back to a demo', async () => {
  const f = await fixture();
  try {
    const health = await fetch(`${f.base}/api/health`).then((r) => r.json());
    assert.equal(health.ok, true); assert.equal(health.engine.available, false);
    assert.match(health.engine.detail, /setup:omr/);
    const response = await fetch(`${f.base}/api/recognize`, { method: 'POST', body: form() });
    assert.equal(response.status, 503); assert.match((await response.json()).message, /Audiveris/);
    assert.deepEqual(await readdir(f.dataDir), []);
  } finally { await f.close(); }
});

test('HTTP queue, generated paths, persisted state, XML response and restart recovery', async () => {
  let active = 0, maximum = 0;
  const engine = fakeEngine(async (_input, output) => {
    active++; maximum = Math.max(active, maximum);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await mkdir(output, { recursive: true });
    const file = path.join(output, 'score.musicxml');
    await writeFile(file, '<score-partwise/>'); active--;
    return { file, warnings: ['校对提示'] };
  });
  const f = await fixture(engine);
  try {
    const uploads = await Promise.all([0, 1].map((index) => fetch(`${f.base}/api/recognize`, { method: 'POST', body: form(Buffer.concat([PNG, Buffer.from([index])]), '../../evil.png') })));
    assert.deepEqual(uploads.map((r) => r.status), [202, 202]);
    const ids: string[] = [];
    for (const response of uploads) { const body = await response.json(); assert.equal(body.status, 'queued'); ids.push(body.id); }
    const jobs = await Promise.all(ids.map((id) => settled(f.base, id)));
    assert.equal(maximum, 1);
    for (let i = 0; i < jobs.length; i++) {
      assert.equal(jobs[i].status, 'done'); assert.deepEqual(jobs[i].warnings, ['校对提示']);
      assert.equal(jobs[i].result, undefined); assert(Number.isFinite(Date.parse(jobs[i].createdAt)));
      const response = await fetch(`${f.base}${jobs[i].resultUrl}`);
      assert.equal(response.status, 200, response.status === 200 ? '' : await response.text()); assert.match(response.headers.get('content-type')!, /musicxml\+xml/);
      assert.equal(await response.text(), '<score-partwise/>');
      const names = await readdir(path.join(f.dataDir, ids[i]));
      assert(names.includes('input.png')); assert(!names.includes('evil.png'));
      const stored = JSON.parse(await readFile(path.join(f.dataDir, ids[i], 'job.json'), 'utf8'));
      assert.equal(stored.result, 'output/score.musicxml');
    }
    const restored = await createApp({ root: f.root, engine });
    assert.equal(restored.idle(), true); restored.close();
  } finally { await f.close(); }
});

test('rejects invalid field, type, content and oversized uploads and cleans files', async () => {
  const f = await fixture(fakeEngine(), { maxUploadBytes: 32 });
  try {
    for (const [data, status] of [[form(PNG, 'score.exe'), 400], [form(Buffer.from('not png')), 415], [form(Buffer.alloc(100)), 413], [new FormData(), 400]] as const) {
      const response = await fetch(`${f.base}/api/recognize`, { method: 'POST', body: data });
      assert.equal(response.status, status, await response.text());
    }
    const wrong = new FormData(); wrong.set('wrong', new Blob([PNG]), 'score.png');
    assert.equal((await fetch(`${f.base}/api/recognize`, { method: 'POST', body: wrong })).status, 400);
    // Response can arrive before finally cleanup; a health round trip lets the handler finish.
    await fetch(`${f.base}/api/health`);
    assert.deepEqual(await readdir(f.dataDir), []);
  } finally { await f.close(); }
});

test('rejects DNS rebinding, hostile Origin and cross-site requests', async () => {
  const f = await fixture(fakeEngine());
  try {
    const rebindingStatus = await new Promise<number>((resolve, reject) => {
      request(`${f.base}/api/health`, { headers: { Host: 'evil.example' } }, (response) => { response.resume(); resolve(response.statusCode!); }).on('error', reject).end();
    });
    assert.equal(rebindingStatus, 403);
    for (const headers of [{ Origin: 'https://evil.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }] as Record<string, string>[]) {
      assert.equal((await fetch(`${f.base}/api/health`, { headers })).status, 403, JSON.stringify(headers));
    }
    assert.equal((await fetch(`${f.base}/api/health`, { headers: { Origin: 'http://127.0.0.1:4380' } })).status, 200);
    assert.equal((await fetch(`${f.base}/api/jobs/not-an-id`)).status, 404);
    assert.equal((await fetch(`${f.base}/api/unknown`)).status, 404);
  } finally { await f.close(); }
});

test('bounded queue rejects excess jobs, engine failure is explicit and score waits', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const f = await fixture(fakeEngine(async () => { await blocked; throw new Error('Real engine failure detail'); }), { maxPendingJobs: 1 });
  try {
    const first = await fetch(`${f.base}/api/recognize`, { method: 'POST', body: form() });
    const { id } = await first.json();
    assert.equal((await fetch(`${f.base}/api/jobs/${id}/score`)).status, 409);
    assert.equal((await fetch(`${f.base}/api/recognize`, { method: 'POST', body: form() })).status, 429);
    release();
    const result = await settled(f.base, id);
    assert.equal(result.status, 'error'); assert.match(result.message, /Real engine failure/);
    assert.equal(result.resultUrl, undefined);
  } finally { release(); await f.close(); }
});

test('serves production SPA/assets, does not turn missing API/assets into HTML, source endpoint is honest', async () => {
  const f = await fixture(fakeEngine());
  try {
    assert.equal(await fetch(`${f.base}/practice/session`).then((r) => r.text()), '<html>practice</html>');
    assert.equal((await fetch(`${f.base}/bundle.js`)).status, 200);
    assert.equal((await fetch(`${f.base}/missing.js`)).status, 404);
    assert.equal((await fetch(`${f.base}/.env`)).status, 404);
    assert.equal(await fetch(`${f.base}/api/license`).then((r) => r.text()), 'AGPL test license');
    assert.equal((await fetch(`${f.base}/api/source`)).status, 503);
    await writeFile(path.join(f.root, '.data/source.zip'), 'ZIP test data');
    const source = await fetch(`${f.base}/api/source`); assert.equal(source.status, 200);
    assert.match(source.headers.get('content-disposition')!, /scorecraft-source.zip/);
  } finally { await f.close(); }
});

test('result discovery rejects symlinks and external result paths', async () => {
  const f = await fixture(fakeEngine(async (_input, output) => {
    await mkdir(output, { recursive: true });
    await symlink(path.join(f.root, 'LICENSE'), path.join(output, 'score.xml'));
    return { file: path.join(output, 'score.xml'), warnings: [] };
  }));
  try {
    const { id } = await fetch(`${f.base}/api/recognize`, { method: 'POST', body: form() }).then((r) => r.json());
    assert.equal((await settled(f.base, id)).status, 'error');
    const output = path.join(f.dataDir, id, 'output');
    assert.equal(await findResult(output), undefined);
  } finally { await f.close(); }
});

test('startup marks interrupted jobs as errors and never serves a persisted external path', async () => {
  const f = await fixture(fakeEngine());
  let restored: Awaited<ReturnType<typeof createApp>> | undefined;
  let restoredServer: ReturnType<typeof f.instance.app.listen> | undefined;
  try {
    const interrupted = '11111111-1111-4111-8111-111111111111';
    const unsafe = '22222222-2222-4222-8222-222222222222';
    for (const id of [interrupted, unsafe]) await mkdir(path.join(f.dataDir, id));
    await writeFile(path.join(f.dataDir, interrupted, 'job.json'), JSON.stringify({ id: interrupted, status: 'running', createdAt: new Date().toISOString() }));
    await writeFile(path.join(f.dataDir, unsafe, 'job.json'), JSON.stringify({ id: unsafe, status: 'done', createdAt: new Date().toISOString(), result: '../../../../outside.xml' }));
    restored = await createApp({ root: f.root, engine: fakeEngine() });
    restoredServer = restored.app.listen(0, '127.0.0.1');
    await once(restoredServer, 'listening');
    const address = restoredServer.address(); assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const job = await fetch(`${base}/api/jobs/${interrupted}`).then((response) => response.json());
    assert.equal(job.status, 'error'); assert.match(job.message, /重启/);
    assert.equal((await fetch(`${base}/api/jobs/${unsafe}/score`)).status, 500);
  } finally {
    restored?.close();
    if (restoredServer) {
      restoredServer.closeAllConnections();
      await new Promise<void>((resolve) => restoredServer!.close(() => resolve()));
    }
    await f.close();
  }
});

test('process execution uses literal arguments and kills timed-out subprocess', async () => {
  const command = await runProcess(process.execPath, ['-e', 'console.log(process.argv[1])', 'literal; echo injected'], { timeoutMs: 2000, cwd: process.cwd() });
  assert.equal(command.code, 0); assert.match(command.output, /literal; echo injected/);
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100, cwd: process.cwd() }), /超时/);
  const engine = createAudiverisEngine({ root: process.cwd(), bin: '/nonexistent/audiveris', probeTimeoutMs: 100 });
  assert.equal((await engine.health()).available, false);
});
