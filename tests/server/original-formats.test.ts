import assert from 'node:assert/strict';
import { test } from 'node:test';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../../server/app.js';

test('historical PDF and JPEG originals use fixed inline MIME and error jobs can be deleted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scorecraft-formats-'));
  const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
  for (let i = 0; i < ids.length; i++) {
    const directory = path.join(root, '.data/jobs', ids[i]);
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'job.json'),
      JSON.stringify({
        id: ids[i],
        status: 'error',
        createdAt: new Date().toISOString(),
        originalName: 'unsafe\r\nX-Injected: yes"中文',
      }),
    );
    await writeFile(
      path.join(directory, i ? 'input.jpg' : 'input.pdf'),
      i ? Buffer.from([255, 216, 255, 0]) : Buffer.from('%PDF-1.4\n'),
    );
  }
  const instance = await createApp({
    root,
    engine: {
      health: async () => ({ available: false, name: 'Audiveris' }),
      recognize: async () => {
        throw new Error('Not used');
      },
    },
  });
  const server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    for (let i = 0; i < ids.length; i++) {
      const response = await fetch(`${base}/api/jobs/${ids[i]}/original`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), i ? 'image/jpeg' : 'application/pdf');
      assert.equal(
        response.headers.get('content-disposition'),
        i ? 'inline; filename="input.jpg"' : 'inline; filename="input.pdf"',
      );
      assert.equal(response.headers.get('x-injected'), null);
      await response.arrayBuffer();
      const deletion = await fetch(`${base}/api/jobs/${ids[i]}`, { method: 'DELETE' });
      assert.equal(deletion.status, 200);
      assert.deepEqual(await deletion.json(), { deleted: true, id: ids[i] });
    }
  } finally {
    instance.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert(root.startsWith(path.join(os.tmpdir(), 'scorecraft-formats-')));
    await rm(root, { recursive: true, force: true });
  }
});
