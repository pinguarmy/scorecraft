import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAudiverisEngine, describeAudiverisFailure } from '../../server/engine';

const cover = `2026-10-24 INFO [input#1] StepMonitoring | SCALE
2026-10-24 WARN [input#1] Book | Error processing stub org.audiveris.omr.step.StepException: No regularly spaced lines found
java.util.concurrent.ExecutionException: org.audiveris.omr.step.StepException: No regularly spaced lines found
Caused by: org.audiveris.omr.step.StepException: No regularly spaced lines found
2026-10-24 INFO [input#8] StepMonitoring | PAGE
Exception occurred java.lang.Exception: Error in reaching step PAGE`;

test('first page staff failure is explained without blaming clarity or exposing stack', () => {
  const message = describeAudiverisFailure(cover, 1);
  assert.match(message, /第 1 页/); assert.match(message, /封面或空白页/); assert.match(message, /没有导出完整/);
  assert.doesNotMatch(message, /java\.|\bat |清晰度/);
  assert.match(describeAudiverisFailure(cover.replaceAll('#1', '#3'), 1), /第 3 页/);
});
test('unknown PAGE and heap failures remain honest and bounded', () => {
  const message = describeAudiverisFailure('java.lang.Exception: Error in reaching step PAGE', 1);
  assert.match(message, /排版或节奏分析失败/); assert.match(message, /不代表图片一定不清晰/); assert.doesNotMatch(message, /封面/);
  assert.match(describeAudiverisFailure('Caused by: java.lang.OutOfMemoryError: Java heap space', 1), /内存不足/);
  assert.match(describeAudiverisFailure('unknown exit output', 2), /退出码 2/);
});
test('exit-zero export reports swallowed metronome failures without raw stack', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scorecraft-engine-warning-'));
  const output = path.join(root, 'output'); await mkdir(output);
  const bin = path.join(root, 'fake-engine'); await writeFile(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  try {
    await writeFile(path.join(output, 'score.musicxml'), '<score-partwise/>');
    await writeFile(path.join(output, 'input.log'), 'No beat unit in metronome line\nError visiting MetronomeInter\njava.lang.NullPointerException');
    const result = await createAudiverisEngine({ root, bin }).recognize(path.join(root, 'input.pdf'), output);
    assert(result.warnings.some(warning => /速度文字或节拍器记号/.test(warning)));
    assert(result.warnings.every(warning => !warning.includes('java.lang')));
  } finally { assert(root.startsWith(path.join(os.tmpdir(), 'scorecraft-engine-warning-'))); await rm(root, { recursive: true, force: true }); }
});

test('engine reads complete local log rather than stdout tail and rejects outside symlink log', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'scorecraft-engine-error-'));
  const output = path.join(root, 'output'); await mkdir(output);
  const bin = path.join(root, 'fake-engine');
  await writeFile(bin, '#!/bin/sh\nprintf "Error in reaching step PAGE\\n"\nexit 1\n', { mode: 0o755 });
  try {
    await writeFile(path.join(output, 'input.log'), cover);
    const engine = createAudiverisEngine({ root, bin });
    await assert.rejects(engine.recognize(path.join(root, 'input.pdf'), output), /第 1 页未找到规律/);
    const log = path.resolve(output, 'input.log'); assert.equal(path.dirname(log), path.resolve(output)); await rm(log);
    const outside = path.join(root, 'outside.log'); await writeFile(outside, cover); await symlink(outside, log);
    await assert.rejects(engine.recognize(path.join(root, 'input.pdf'), output), /排版或节奏分析失败/);
  } finally { assert(root.startsWith(path.join(os.tmpdir(), 'scorecraft-engine-error-'))); await rm(root, { recursive: true, force: true }); }
});
