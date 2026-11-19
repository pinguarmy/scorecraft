import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { createAudiverisEngine, type RecognitionEngine } from '../../server/engine';
import { createApp } from '../../server/app';
const coverError = 'WARN [input#1] Book | Error processing stub org.audiveris.omr.step.StepException: No regularly spaced lines found\nException occurred java.lang.Exception: Error in reaching step PAGE';
function book(first = 'invalid', remaining = 'PAGE', pages = 3) {
  return zipSync({ 'book.xml': strToU8(`<book><sheet number="1"${first === 'invalid' ? ' invalid="true"' : ''}><steps>${first === 'PAGE' ? 'LOAD PAGE' : 'LOAD BINARY'}</steps></sheet>${Array.from({ length: pages - 1 }, (_, i) => `<sheet number="${i + 2}"${remaining === 'invalid' ? ' invalid="true"' : ''}><steps>LOAD ${remaining}</steps></sheet>`).join('')}</book>`) });
}
async function fixture(log = coverError, archive = book(), unsafe = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scorecraft-auto-cover-')); const output = path.join(root, 'output'); await mkdir(output);
  const original = path.join(output, 'input.omr');
  if (unsafe) { await writeFile(path.join(root, 'outside.omr'), archive); await symlink(path.join(root, 'outside.omr'), original); }
  else await writeFile(original, archive);
  await writeFile(path.join(root, 'input.pdf'), '%PDF-test');
  await writeFile(path.join(output, 'input.log'), log);
  const bin = path.join(root, 'engine');
  await writeFile(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> calls.txt\ncase " $* " in *" -transcribe "*) echo 'Error in reaching step PAGE'; exit 1;; esac\nlast=''\nfor arg in "$@"; do last="$arg"; done\nprintf '<score-partwise/>' > "$(dirname "$last")/recovery.musicxml"\nexit 0\n`, { mode: 0o755 });
  return { root, output, original, input: path.join(root, 'input.pdf'), engine: createAudiverisEngine({ root, bin }), async close() { assert(root.startsWith(path.join(os.tmpdir(), 'scorecraft-auto-cover-'))); await rm(root, { recursive: true, force: true }); } };
}
test('confirmed first nonmusic page automatically exports all remaining complete pages in same call', async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.original); const inputBefore = await readFile(f.input);
    const result = await f.engine.recognize(f.input, f.output);
    assert.equal(result.autoSkippedCover, true); assert.deepEqual(result.skippedPages, [1]); assert.equal(result.pageCount, 3);
    assert(result.file.endsWith('/autocover/recovery.musicxml')); assert(result.warnings.some(w => /自动跳过/.test(w)));
    const calls = (await readFile(path.join(f.root, 'calls.txt'), 'utf8')).trim().split('\n'); assert.equal(calls.length, 2); assert.match(calls[0], /-transcribe/); assert.match(calls[1], /-sheets 2-3/); assert.doesNotMatch(calls[1], /-transcribe/);
    assert.deepEqual(await readFile(f.original), before); assert.deepEqual(await readFile(f.input), inputBefore);
  } finally { await f.close(); }
});
test('non-first failure, music PAGE failure, incomplete remainder, one page and symlink refuse auto recovery', async () => {
  const cases = [
    { log: coverError.replace('#1', '#2'), archive: book() },
    { log: 'WARN [input#1] Error processing stub java.lang.NullPointerException\n' + coverError, archive: book() },
    { log: coverError, archive: book('PAGE') },
    { log: coverError, archive: book('invalid', 'GRID') },
    { log: coverError, archive: book('invalid', 'invalid') },
    { log: coverError, archive: book('invalid', 'PAGE', 1) },
    { log: coverError, archive: book(), unsafe: true },
  ];
  for (const item of cases) {
    const f = await fixture(item.log, item.archive, item.unsafe);
    try { await assert.rejects(f.engine.recognize(f.input, f.output)); assert.equal((await readFile(path.join(f.root, 'calls.txt'), 'utf8')).trim().split('\n').length, 1); }
    finally { await f.close(); }
  }
});
test('ordinary HTTP job publishes automatic skip metadata without error state or manual retry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scorecraft-auto-cover-http-'));
  const engine: RecognitionEngine = { health: async () => ({ available: true, name: 'Audiveris' }), recognize: async (_input, output) => {
    await mkdir(output, { recursive: true }); const file = path.join(output, 'score.musicxml'); await writeFile(file, '<score-partwise/>');
    return { file, warnings: ['已自动跳过第 1 页'], skippedPages: [1], pageCount: 3, autoSkippedCover: true };
  } };
  const instance = await createApp({ root, engine }); const server = instance.app.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert(address && typeof address !== 'string'); const base = `http://127.0.0.1:${address.port}`;
  try {
    const form = new FormData(); form.set('file', new Blob(['%PDF-test'], { type: 'application/pdf' }), 'score.pdf'); const response = await fetch(`${base}/api/recognize`, { method: 'POST', body: form }); assert.equal(response.status, 202); const { id } = await response.json();
    let job;
    for (let i = 0; i < 100; i++) { job = await fetch(`${base}/api/jobs/${id}`).then(r => r.json()); assert.notEqual(job.status, 'error'); if (job.status === 'done') break; await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(job.status, 'done'); assert.equal(job.autoSkippedCover, true); assert.deepEqual(job.skippedPages, [1]); assert.equal(job.pageCount, 3); assert.equal(job.sourceJobId, undefined);
    const metadata = JSON.parse(await readFile(path.join(root, '.data/jobs', id, 'job.json'), 'utf8')); assert.equal(metadata.recognitionRevision, 'v063-auto-cover'); assert.equal(metadata.autoSkippedCover, true);
    assert.equal(await fetch(`${base}/api/jobs/${id}/original`).then(r => r.text()), '%PDF-test');
  } finally { instance.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); assert(root.startsWith(path.join(os.tmpdir(), 'scorecraft-auto-cover-http-'))); await rm(root, { recursive: true, force: true }); }
});
