import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/app';

const engine = {
  health: async () => ({ available: false, name: 'Audiveris' as const }),
  recognize: async () => {
    throw new Error('unused');
  },
};
const id = `sha256:${'1'.padStart(64, '0')}`;
const document = { id, title: 'Study', composer: '', source: 'fixture.musicxml', opened: 1, xml: '<score-partwise/>', session: {} };

async function exists(target: string) {
  return access(target).then(() => true, () => false);
}

test('libraryDir and dataDir keep saved scores and scan jobs out of the default .data folders', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scorecraft-data-dir-'));
  const instance = await createApp({
    root,
    engine,
    dataDir: path.join(root, '.data/e2e/jobs'),
    libraryDir: path.join(root, '.data/e2e/library'),
  });
  const server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const saved = await fetch(`${base}/api/library/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(document),
    });
    assert.equal(saved.status, 200);
    assert.equal((await readdir(path.join(root, '.data/e2e/library'))).length, 1);
    assert.equal(await exists(path.join(root, '.data/library')), false);
    assert.equal(await exists(path.join(root, '.data/jobs')), false);
    assert.equal(await exists(path.join(root, '.data/e2e/jobs')), true);
    const listed = await fetch(`${base}/api/library`).then(response => response.json());
    assert.equal(listed.documents.length, 1);
  } finally {
    instance.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('a libraryDir outside the project directory is refused', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scorecraft-data-dir-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'scorecraft-data-outside-'));
  try {
    await assert.rejects(createApp({ root, engine, libraryDir: path.join(outside, 'library') }), /项目目录内/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
