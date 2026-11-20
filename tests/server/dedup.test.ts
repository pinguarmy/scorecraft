import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp, RECOGNITION_REVISION } from '../../server/app.js';
import type { RecognitionEngine } from '../../server/engine.js';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const JPEG = Buffer.from([255, 216, 255, 0, 0, 0, 0, 0]);
function form(bytes = PNG, name = 'score.png') {
  const data = new FormData();
  data.set(
    'file',
    new Blob([new Uint8Array(bytes)], {
      type: name.endsWith('.png') || name.endsWith('.PNG') ? 'image/png' : 'image/jpeg',
    }),
    name,
  );
  return data;
}
function deferred() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
async function outputFile(output: string) {
  await mkdir(output, { recursive: true });
  const file = path.join(output, 'score.musicxml');
  await writeFile(file, '<score-partwise/>');
  return { file, warnings: ['Mocked recognition only.'] };
}
async function fixture(action?: RecognitionEngine['recognize']) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scorecraft-dedup-'));
  const data = path.join(root, '.data/jobs');
  let calls = 0;
  const engine: RecognitionEngine = {
    health: async () => ({ available: true, name: 'Audiveris', version: 'mock' }),
    recognize: async (input, output) => {
      calls++;
      return action ? action(input, output) : outputFile(output);
    },
  };
  let instance = await createApp({ root, engine, maxPendingJobs: 8 });
  let server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  function base() {
    const address = server.address();
    assert(address && typeof address !== 'string');
    return `http://127.0.0.1:${address.port}`;
  }
  async function stop() {
    instance.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return {
    root,
    data,
    calls: () => calls,
    async upload(bytes = PNG, name = 'score.png', force = false) {
      const response = await fetch(`${base()}/api/recognize${force ? '?force=1' : ''}`, {
        method: 'POST',
        body: form(bytes, name),
      });
      assert.equal(response.status, 202);
      return response.json();
    },
    async get(url: string) {
      return fetch(`${base()}${url}`);
    },
    async remove(id: string) {
      return fetch(`${base()}/api/jobs/${id}`, { method: 'DELETE' });
    },
    async settled(id: string) {
      for (let i = 0; i < 200; i++) {
        const job = await fetch(`${base()}/api/jobs/${id}`).then((r) => r.json());
        if (job.status === 'done' || job.status === 'error') return job;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('Mock job did not settle');
    },
    async restart() {
      await stop();
      instance = await createApp({ root, engine, maxPendingJobs: 8 });
      server = instance.app.listen(0, '127.0.0.1');
      await once(server, 'listening');
    },
    async close() {
      await stop();
      assert(path.resolve(root).startsWith(path.join(os.tmpdir(), 'scorecraft-dedup-')));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('concurrent identical uploads merge running/queued work atomically and completed work is reused privately', async () => {
  const gate = deferred();
  const f = await fixture(async (_input, output) => {
    await gate.wait;
    return outputFile(output);
  });
  try {
    const responses = await Promise.all([f.upload(), f.upload(PNG, 'renamed.PNG'), f.upload()]);
    assert.equal(new Set(responses.map((job) => job.id)).size, 1);
    assert.equal(responses.filter((job) => job.reused === true).length, 2);
    assert.equal(f.calls(), 1);
    const other = await f.upload(Buffer.concat([PNG, Buffer.from('other')]));
    assert.notEqual(other.id, responses[0].id);
    const queued = await f.upload(Buffer.concat([PNG, Buffer.from('other')]));
    assert.equal(queued.id, other.id);
    assert.equal(queued.status, 'queued');
    assert.equal(queued.reused, true);
    gate.release();
    await f.settled(responses[0].id);
    await f.settled(other.id);
    const done = await f.upload();
    assert.equal(done.id, responses[0].id);
    assert.equal(done.status, 'done');
    assert.equal(done.reused, true);
    assert.equal(f.calls(), 2);
    const publicMetadata = await (await f.get(`/api/jobs/${done.id}`)).json();
    const listing = await (await f.get('/api/jobs')).text();
    assert.equal(publicMetadata.inputSha256, undefined);
    assert.equal(publicMetadata.inputExtension, undefined);
    assert.equal(publicMetadata.recognitionRevision, undefined);
    assert(!listing.includes('inputSha256'));
    assert(!listing.includes(RECOGNITION_REVISION));
    const persisted = JSON.parse(await readFile(path.join(f.data, done.id, 'job.json'), 'utf8'));
    assert.match(persisted.inputSha256, /^[0-9a-f]{64}$/);
    assert.equal(persisted.inputExtension, '.png');
    assert.equal(persisted.recognitionRevision, RECOGNITION_REVISION);
    // Handler cleanup is async after sending 202. A round trip lets the reused-upload cleanup finish.
    for (let i = 0; i < 100 && (await readdir(f.data)).length !== 2; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal((await readdir(f.data)).length, 2);
  } finally {
    gate.release();
    await f.close();
  }
});

test('same bytes require normalized extension and different content never merges', async () => {
  const f = await fixture();
  try {
    const png = await f.upload();
    await f.settled(png.id);
    assert.equal((await f.upload(PNG, 'different.PNG')).id, png.id);
    const changed = await f.upload(Buffer.concat([PNG, Buffer.from('new')]));
    assert.notEqual(changed.id, png.id);
    await f.settled(changed.id);
    const jpg = await f.upload(JPEG, 'photo.jpg');
    await f.settled(jpg.id);
    const jpeg = await f.upload(JPEG, 'photo.jpeg');
    assert.notEqual(jpeg.id, jpg.id);
    await f.settled(jpeg.id);
    assert.equal(f.calls(), 4);
  } finally {
    await f.close();
  }
});

test('completed digest survives restart but old/missing revision, digest or changed original bytes do not reuse', async () => {
  const f = await fixture();
  try {
    let current = await f.upload();
    await f.settled(current.id);
    await f.restart();
    assert.equal((await f.upload()).id, current.id);
    assert.equal(f.calls(), 1);
    for (const mutation of ['revision', 'missing', 'invalidDigest', 'changedInput']) {
      const metadataPath = path.join(f.data, current.id, 'job.json');
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
      if (mutation === 'revision') metadata.recognitionRevision = 'older-engine-profile';
      if (mutation === 'missing') {
        delete metadata.inputSha256;
        delete metadata.recognitionRevision;
      }
      if (mutation === 'invalidDigest') metadata.inputSha256 = 'not-a-digest';
      if (mutation === 'changedInput')
        await writeFile(path.join(f.data, current.id, 'input.png'), Buffer.concat([PNG, Buffer.from('tampered')]));
      else await writeFile(metadataPath, JSON.stringify(metadata));
      await f.restart();
      const fresh = await f.upload();
      assert.notEqual(fresh.id, current.id, mutation);
      assert.equal(fresh.reused, undefined);
      await f.settled(fresh.id);
      current = fresh;
    }
    assert.equal(f.calls(), 5);
  } finally {
    await f.close();
  }
});

test('force=1 always schedules an independent scan without weakening later ordinary reuse', async () => {
  const gate = deferred();
  const f = await fixture(async (_input, output) => {
    await gate.wait;
    return outputFile(output);
  });
  try {
    const jobs = await Promise.all([f.upload(), f.upload(PNG, 'same.png', true), f.upload(PNG, 'same.png', true)]);
    assert.equal(new Set(jobs.map((job) => job.id)).size, 3);
    assert(jobs.every((job) => job.reused === undefined));
    gate.release();
    for (const job of jobs) await f.settled(job.id);
    assert.equal(f.calls(), 3);
    assert.equal((await f.upload()).reused, true);
    assert.equal(f.calls(), 3);
  } finally {
    gate.release();
    await f.close();
  }
});

test('failed scan can retry, terminal deletion invalidates reuse', async () => {
  let fail = true;
  const f = await fixture(async (_input, output) => {
    if (fail) throw new Error('mock failure');
    return outputFile(output);
  });
  try {
    const failed = await f.upload();
    assert.equal((await f.settled(failed.id)).status, 'error');
    fail = false;
    const retry = await f.upload();
    assert.notEqual(retry.id, failed.id);
    await f.settled(retry.id);
    assert.equal((await f.remove(retry.id)).status, 200);
    const afterDelete = await f.upload();
    assert.notEqual(afterDelete.id, retry.id);
    await f.settled(afterDelete.id);
    assert.equal(f.calls(), 3);
  } finally {
    await f.close();
  }
});

test('done result must exist, be nonempty and stay in a plain safe job path', async () => {
  const f = await fixture();
  try {
    let previous: string | undefined;
    for (const kind of ['missing', 'empty', 'symlink', 'outside']) {
      const job = await f.upload();
      if (previous) assert.notEqual(job.id, previous);
      await f.settled(job.id);
      previous = job.id;
      const result = path.resolve(f.data, job.id, 'output/score.musicxml');
      assert.equal(path.dirname(result), path.resolve(f.data, job.id, 'output'));
      if (kind === 'empty') await writeFile(result, '');
      else if (kind === 'outside') {
        const metadataPath = path.join(f.data, job.id, 'job.json');
        const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
        metadata.result = '../../../outside.musicxml';
        await writeFile(metadataPath, JSON.stringify(metadata));
        await f.restart();
      } else {
        await rm(result);
        if (kind === 'symlink') {
          const outside = path.join(f.root, 'outside.musicxml');
          await writeFile(outside, '<score-partwise/>');
          await symlink(outside, result);
        }
      }
    }
    const fresh = await f.upload();
    assert.notEqual(fresh.id, previous);
    await f.settled(fresh.id);
    assert.equal(f.calls(), 5);
  } finally {
    await f.close();
  }
});
