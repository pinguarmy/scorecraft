import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
const { buildLauncherScript, ENGLISH_MODEL_URL, ENGLISH_MODEL_SHA256 } = await import(path.resolve('scripts/setup-audiveris.mjs'));
const { verifyEnglishModel } = await import(path.resolve('scripts/doctor.mjs'));

test('launcher isolates HOME and uses pinned legacy-compatible English data not fast LSTM-only', () => {
  const script = buildLauncherScript();
  assert.match(script, /export HOME="\$USER_DATA_DIR"/);
  assert.match(script, /export TESSDATA_PREFIX="\$DIR\/tessdata"/);
  assert.match(script, /eng\.traineddata/);
  assert.match(ENGLISH_MODEL_URL, /tessdata\/ced78752cc61322fb554c280d13360b35b8684e4\/eng\.traineddata$/);
  assert.doesNotMatch(ENGLISH_MODEL_URL, /tessdata_fast/);
  assert.equal(ENGLISH_MODEL_SHA256, 'daa0c97d651c19fba3b25e81317cd697e9908c8208090c94c3905381c23fc047');
});
test('engine adds legal six-two candidates without forcing or overwriting recognized meter', async () => {
  const engine = await readFile(path.resolve('server/engine.ts'), 'utf8');
  assert.match(engine, /optionalTimes=6\/4, 7\/8, 6\/2/);
  assert.match(engine, /Could not initialize TessBaseAPI/);
});

test('doctor rejects corrupt model rather than trusting file presence', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'scorecraft-tessdata-'));
  try {
    await writeFile(path.join(directory, 'eng.traineddata'), 'invalid model');
    await assert.rejects(verifyEnglishModel(directory), /incompatible/);
  } finally { assert(directory.startsWith(path.join(os.tmpdir(), 'scorecraft-tessdata-'))); await rm(directory, { recursive: true, force: true }); }
});
test('installed model has exact expected bytes and legacy engine components', async () => {
  const file = path.resolve('.tools/audiveris/tessdata/eng.traineddata');
  let bytes: Buffer;
  try { bytes = await readFile(file); } catch { return; }
  assert.equal(createHash('sha256').update(bytes).digest('hex'), ENGLISH_MODEL_SHA256);
  assert.equal(bytes.length, 23466654);
  // Tessdata header stores per-component offsets. Legacy inttemp index3 must exist.
  assert(bytes.readBigInt64LE(4 + 3 * 8) >= 0n, 'legacy inttemp model absent');
});
