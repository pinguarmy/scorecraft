import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

test('a checkout below a dot-directory serves the app, licence and source, and still denies dotfiles', async () => {
  const base = await mkdtemp(path.join(os.tmpdir(), 'scorecraft-dotpath-'));
  // Like ~/.local/src/scorecraft or a worktree under .claude/worktrees.
  const root = path.join(base, '.local', 'src', 'scorecraft');
  const files: Record<string, string> = {
    'dist/index.html': '<!doctype html><title>practice desk</title>',
    'dist/.secret': 'dist dotfile',
    'dist/assets/.hidden.js': 'hidden asset',
    'dist/.git/config': 'dot-directory file',
    LICENSE: 'AGPL test license',
    '.data/source.zip': 'PK fake source archive',
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
  const url = `http://127.0.0.1:${address.port}`;
  try {
    for (const route of ['/', '/library/recent']) {
      const response = await fetch(`${url}${route}`);
      assert.equal(response.status, 200, route);
      assert.match(response.headers.get('content-type') ?? '', /text\/html/, route);
      assert.match(await response.text(), /practice desk/, route);
    }

    const license = await fetch(`${url}/api/license`);
    assert.equal(license.status, 200);
    assert.match(license.headers.get('content-type') ?? '', /text\/plain/);
    assert.equal(await license.text(), 'AGPL test license');

    const source = await fetch(`${url}/api/source`);
    assert.equal(source.status, 200);
    assert.match(source.headers.get('content-disposition') ?? '', /attachment; filename="?scorecraft-source\.zip"?/);
    assert.equal(await source.text(), 'PK fake source archive');

    for (const route of ['/.secret', '/assets/.hidden.js', '/.git/config']) {
      const response = await fetch(`${url}${route}`);
      assert.notEqual(response.status, 200, route);
      assert.doesNotMatch(await response.text(), /dotfile|hidden asset|dot-directory file/, route);
    }
    // An encoded dot is still refused by the static handler; the SPA fallback then answers with the app page.
    const encoded = await fetch(`${url}/%2esecret`);
    assert.doesNotMatch(await encoded.text(), /dist dotfile/);
  } finally {
    instance.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    assert(base.startsWith(path.join(os.tmpdir(), 'scorecraft-dotpath-')));
    await rm(base, { recursive: true, force: true });
  }
});
