import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../../server/app.js';
import type { RecognitionEngine } from '../../server/engine.js';

const engine: RecognitionEngine = {
  health: async () => ({ available: false, name: 'Audiveris' }),
  recognize: async () => {
    throw new Error('Not used');
  },
};

const IMMUTABLE = 'public, max-age=31536000, immutable';
const UNHASHED = 'public, max-age=3600';

/**
 * A plain conditional GET. fetch() is not usable here: a request with If-None-Match bypasses its cache and
 * then also sends Cache-Control: no-cache, which makes the server send the full file.
 */
function conditionalGet(url: string, etag: string): Promise<{ status: number; cacheControl?: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(url, { headers: { 'If-None-Match': etag } }, (incoming) => {
      incoming.resume();
      incoming.once('end', () =>
        resolve({ status: incoming.statusCode ?? 0, cacheControl: incoming.headers['cache-control'] }),
      );
    });
    outgoing.once('error', reject);
    outgoing.end();
  });
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scorecraft-static-'));
  const files: Record<string, string> = {
    'dist/index.html': '<!doctype html><title>practice</title>',
    'dist/assets/index-AbC_d-12.js': 'console.log("hashed")',
    'dist/assets/index-AbC_d-12.js.map': '{}',
    'dist/assets/index-Zx9QwErT.css': 'body{}',
    'dist/assets/unhashed.js': 'console.log("unhashed")',
    'dist/audio/piano/A0.mp3': 'not really an mp3',
    'dist/samples/first-light.musicxml': '<score-partwise/>',
    'public/samples/dev-only.musicxml': '<score-partwise/>',
  };
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  const instance = await createApp({ root, engine });
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
      assert(root.startsWith(path.join(os.tmpdir(), 'scorecraft-static-')));
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('content-hashed build assets are immutable and carry no document policy', async () => {
  const f = await fixture();
  try {
    for (const asset of ['/assets/index-AbC_d-12.js', '/assets/index-AbC_d-12.js.map', '/assets/index-Zx9QwErT.css']) {
      const response = await fetch(`${f.base}${asset}`);
      assert.equal(response.status, 200, asset);
      assert.equal(response.headers.get('cache-control'), IMMUTABLE, asset);
      assert.equal(response.headers.get('content-security-policy'), null, asset);
      await response.arrayBuffer();
    }
    const unhashed = await fetch(`${f.base}/assets/unhashed.js`);
    assert.equal(unhashed.headers.get('cache-control'), UNHASHED, 'a name without a hash is not immutable');
    await unhashed.arrayBuffer();
  } finally {
    await f.close();
  }
});

test('the app document and the SPA fallback are revalidated on every load and carry the CSP', async () => {
  const f = await fixture();
  try {
    for (const route of ['/', '/index.html', '/library', '/some/client/route']) {
      const response = await fetch(`${f.base}${route}`);
      assert.equal(response.status, 200, route);
      assert.equal(response.headers.get('cache-control'), 'no-cache', route);
      const policy = response.headers.get('content-security-policy') ?? '';
      assert.match(policy, /default-src 'self'/, route);
      assert.match(policy, /script-src 'self'(;|$)/, route);
      assert.match(policy, /frame-ancestors 'none'/, route);
      assert.doesNotMatch(policy, /unsafe-eval|\*/, route);
      assert.match(await response.text(), /practice/, route);
    }
  } finally {
    await f.close();
  }
});

test('samples with stable names get a modest max-age and then revalidate by ETag', async () => {
  const f = await fixture();
  try {
    for (const file of ['/audio/piano/A0.mp3', '/samples/first-light.musicxml', '/samples/dev-only.musicxml']) {
      const response = await fetch(`${f.base}${file}`);
      assert.equal(response.status, 200, file);
      assert.equal(response.headers.get('cache-control'), UNHASHED, file);
      const etag = response.headers.get('etag');
      assert(etag, `${file} has an ETag`);
      await response.arrayBuffer();
      const revalidated = await conditionalGet(`${f.base}${file}`, etag);
      assert.equal(revalidated.status, 304, file);
      assert.equal(revalidated.cacheControl, UNHASHED, file);
    }
  } finally {
    await f.close();
  }
});

test('API responses, including errors, are never cached', async () => {
  const f = await fixture();
  try {
    for (const [route, status] of [
      ['/api/health', 200],
      ['/api/jobs', 200],
      ['/api/missing', 404],
      ['/api/jobs/not-a-job', 404],
    ] as const) {
      const response = await fetch(`${f.base}${route}`);
      assert.equal(response.status, status, route);
      assert.equal(response.headers.get('cache-control'), 'no-store', route);
      await response.arrayBuffer();
    }
    const missingFile = await fetch(`${f.base}/audio/piano/missing.mp3`);
    assert.equal(missingFile.status, 404);
    assert.equal(missingFile.headers.get('cache-control'), null, 'a missing file is not cached as if it existed');
  } finally {
    await f.close();
  }
});
