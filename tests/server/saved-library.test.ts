import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../../server/app';
const id = (n: number) => `sha256:${n.toString(16).padStart(64, '0')}`;
function document(n = 1, xml = '<score-partwise/>') {
  return {
    id: id(n),
    title: `Study ${n}`,
    composer: 'Original test',
    source: 'fixture.musicxml',
    opened: 100 + n,
    xml,
    session: {
      tempo: 132,
      transpose: 2,
      muted: ['left'],
      solo: 'right',
      metronome: true,
      countIn: true,
      loop: true,
      loopStart: 2,
      loopEnd: 18,
      position: 57.5,
      followRepeats: false,
      followMode: 'page',
      followEnabled: false,
      partInstruments: { right: 'guitar-acoustic', left: 'piano-warm' },
    },
  };
}
async function fixture(root?: string) {
  const own = !root;
  root ??= await mkdtemp(path.join(os.tmpdir(), 'scorecraft-saved-library-'));
  const instance = await createApp({
    root,
    engine: {
      health: async () => ({ available: false, name: 'Audiveris' }),
      recognize: async () => {
        throw new Error('unused');
      },
    },
  });
  const server = instance.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  return {
    root,
    base,
    async close(remove = own) {
      instance.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (remove) {
        assert(root!.startsWith(path.join(os.tmpdir(), 'scorecraft-saved-library-')));
        await rm(root!, { recursive: true, force: true });
      }
    },
  };
}
const put = (base: string, doc: ReturnType<typeof document>, query = '') =>
  fetch(`${base}/api/library/${encodeURIComponent(doc.id)}${query}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(doc),
  });
const patch = (base: string, n: number, body: unknown) =>
  fetch(`${base}/api/library/${encodeURIComponent(id(n))}/session`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('850KB XML and fifth document persist with full practice session after app recreation', async () => {
  const f = await fixture();
  let restored: Awaited<ReturnType<typeof fixture>> | undefined;
  const xml = '<score-partwise><!--' + 'x'.repeat(850000) + '--></score-partwise>';
  try {
    for (let n = 1; n <= 5; n++) {
      const response = await put(f.base, document(n, n === 1 ? xml : '<score-partwise/>'));
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(typeof result.updatedAt, 'number');
    }
    const list = await fetch(`${f.base}/api/library`).then((r) => r.json());
    assert.equal(list.documents.length, 5);
    assert(
      list.documents.every((item: Record<string, unknown>) => item.xml === undefined && item.session === undefined),
    );
    await f.close(false);
    restored = await fixture(f.root);
    const response = await fetch(`${restored.base}/api/library/${encodeURIComponent(id(1))}`);
    assert.equal(response.status, 200);
    const loaded = await response.json();
    assert.equal(loaded.xml, xml);
    assert.equal(loaded.session.position, 57.5);
    assert.equal(loaded.session.tempo, 132);
    assert.equal(loaded.session.loopEnd, 18);
    assert.deepEqual(loaded.session.partInstruments, document().session.partInstruments);
    assert.equal(loaded.session.followMode, 'page');
    assert.equal((await fetch(`${restored.base}/api/library`).then((r) => r.json())).documents.length, 5);
    const names = await readdir(path.join(f.root, '.data/library'));
    assert.equal(names.length, 5);
    assert(names.every((name) => /^[a-f0-9]{64}\.json$/.test(name)));
  } finally {
    if (restored) await restored.close(true);
    else await f.close();
  }
});
test('session PATCH preserves exact XML and metadata, missing document is 404, createOnly cannot overwrite', async () => {
  const f = await fixture();
  const doc = document(1, '<score-partwise><!--precise source--></score-partwise>');
  try {
    assert.equal((await patch(f.base, 1, { session: doc.session, opened: 200 })).status, 404);
    assert.equal((await put(f.base, doc, '?createOnly=1')).status, 200);
    assert.equal((await put(f.base, { ...doc, xml: '<changed/>' }, '?createOnly=1')).status, 409);
    const result = await patch(f.base, 1, { session: { ...doc.session, position: 62.25, tempo: 144 }, opened: 500 });
    assert.equal(result.status, 200);
    const summary = await result.json();
    assert.equal(summary.xmlBytes, Buffer.byteLength(doc.xml));
    const loaded = await fetch(`${f.base}/api/library/${encodeURIComponent(doc.id)}`).then((r) => r.json());
    assert.equal(loaded.xml, doc.xml);
    assert.equal(loaded.title, doc.title);
    assert.equal(loaded.opened, 500);
    assert.equal(loaded.session.position, 62.25);
    assert.equal(loaded.session.tempo, 144);
    const first = patch(f.base, 1, { session: { ...doc.session, position: 65 }, opened: 600 });
    const second = patch(f.base, 1, { session: { ...doc.session, position: 66 }, opened: 601 });
    assert((await Promise.all([first, second])).every((r) => r.status === 200));
    assert.equal(
      (await fetch(`${f.base}/api/library/${encodeURIComponent(doc.id)}`).then((r) => r.json())).session.position,
      66,
    );
  } finally {
    await f.close();
  }
});
test('input limits reject invalid IDs, mismatches, DTD, oversized XML/JSON and foreign origins', async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(`${f.base}/api/library/not-a-document`)).status, 400);
    assert.equal((await fetch(`${f.base}/api/library/${encodeURIComponent(id(9))}`)).status, 404);
    assert.equal((await put(f.base, { ...document(), id: 'sha256:invalid' })).status, 400);
    assert.equal((await put(f.base, document(1, '<!DOCTYPE score-partwise><score-partwise/>'))).status, 400);
    assert.equal((await put(f.base, document(1, 'x'.repeat(8 * 1024 * 1024 + 1)))).status, 400);
    const huge = await fetch(`${f.base}/api/library/${encodeURIComponent(id(1))}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...document(), xml: 'x'.repeat(10 * 1024 * 1024) }),
    });
    assert.equal(huge.status, 413);
    assert.equal(
      (
        await fetch(`${f.base}/api/library/${encodeURIComponent(id(1))}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
          body: JSON.stringify(document()),
        })
      ).status,
      403,
    );
    assert.deepEqual(await readdir(path.join(f.root, '.data/library')), []);
  } finally {
    await f.close();
  }
});
test('optimistic concurrency returns 409 for outdated PUT/PATCH and enforces monotonic updatedAt', async () => {
  const f = await fixture();
  const doc = document(1, '<score-partwise><!--base score--></score-partwise>');
  try {
    const initRes = await put(f.base, doc);
    assert.equal(initRes.status, 200);
    const initReceipt = await initRes.json();
    const v1 = initReceipt.updatedAt;
    assert.equal(typeof v1, 'number');

    // Tab 1 updates based on v1
    const tab1Res = await fetch(`${f.base}/api/library/${encodeURIComponent(doc.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': `"${v1}"` },
      body: JSON.stringify({ ...doc, xml: '<score-partwise><!--tab 1 edit--></score-partwise>' }),
    });
    assert.equal(tab1Res.status, 200);
    const tab1Receipt = await tab1Res.json();
    const v2 = tab1Receipt.updatedAt;
    assert(v2 > v1, 'new version must be strictly greater than v1');

    // Tab 2 tries to update based on old v1 -> must fail with 409
    const tab2Res = await fetch(`${f.base}/api/library/${encodeURIComponent(doc.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'If-Match': `"${v1}"` },
      body: JSON.stringify({ ...doc, xml: '<score-partwise><!--tab 2 overwrite attempt--></score-partwise>' }),
    });
    assert.equal(tab2Res.status, 409);
    const tab2Error = await tab2Res.json();
    assert.match(tab2Error.message, /冲突/);

    // Tab 2 PATCH based on old v1 -> must also fail with 409
    const patchRes = await fetch(`${f.base}/api/library/${encodeURIComponent(doc.id)}/session`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'If-Match': `"${v1}"` },
      body: JSON.stringify({ session: { ...doc.session, position: 99 }, opened: 300 }),
    });
    assert.equal(patchRes.status, 409);

    // Verify Tab 1's content remained intact
    const loaded = await fetch(`${f.base}/api/library/${encodeURIComponent(doc.id)}`).then((r) => r.json());
    assert.equal(loaded.xml, '<score-partwise><!--tab 1 edit--></score-partwise>');
  } finally {
    await f.close();
  }
});

test('symlink targets are refused and scan jobs remain independent of saved documents', async () => {
  const f = await fixture();
  try {
    const outside = path.join(f.root, 'outside.json');
    await writeFile(outside, 'do not change');
    const target = path.join(f.root, '.data/library', createHash('sha256').update(id(1)).digest('hex') + '.json');
    await symlink(outside, target);
    assert.equal((await put(f.base, document())).status, 500);
    assert.equal(await readFile(outside, 'utf8'), 'do not change');
    assert.equal((await fetch(`${f.base}/api/library`).then((r) => r.json())).documents.length, 0);
    assert.equal((await fetch(`${f.base}/api/jobs`).then((r) => r.json())).jobs.length, 0);
  } finally {
    await f.close();
  }
});
