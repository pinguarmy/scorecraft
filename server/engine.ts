import { spawn } from 'node:child_process';
import { access, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { FlateErrorCode, unzipSync, strFromU8, type UnzipFileFilter } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import path from 'node:path';
import { assertPlainPath } from './job-files.js';

export type EngineHealth = { available: boolean; name: 'Audiveris'; version?: string; detail?: string };
export interface RecognitionEngine {
  health(): Promise<EngineHealth>;
  recognize(input: string, output: string, options?: { skipFirstPage?: boolean; pageCount?: number; archive?: string }): Promise<{ file: string; warnings: string[]; skippedPages?: number[]; pageCount?: number; autoSkippedCover?: true }>;
}
/** An Audiveris .omr archive that is missing, unsafe, malformed or unusable for page selection. */
export class RecognitionArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecognitionArchiveError';
  }
}

/** fflate reports a file that is not a ZIP archive with this error code (and the message "invalid zip data"). */
function isInvalidZipData(error: unknown): boolean {
  return error instanceof Error && (error as Error & { code?: unknown }).code === FlateErrorCode.InvalidZipData;
}

function unzipArchive(bytes: Uint8Array, filter: UnzipFileFilter) {
  try {
    return unzipSync(bytes, { filter });
  } catch (error) {
    if (isInvalidZipData(error)) throw new RecognitionArchiveError((error as Error).message);
    throw error;
  }
}

export async function inspectRecognitionArchive(file: string, includeFirstState = false): Promise<{ pageCount: number; remainingComplete: boolean; firstInvalidWithoutPage?: boolean }> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 * 1024) throw new RecognitionArchiveError('识别档案无效。');
  const zip = unzipArchive(new Uint8Array(await readFile(file)), entry => entry.name === 'book.xml' && entry.originalSize <= 2 * 1024 * 1024);
  if (!zip['book.xml']) throw new RecognitionArchiveError('识别档案缺少页数信息。');
  const xml = strFromU8(zip['book.xml']);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new RecognitionArchiveError('识别档案含不安全 XML。');
  const document = new DOMParser().parseFromString(xml, 'text/xml');
  const sheets = Array.from(document.documentElement.childNodes).filter((node): node is Element => node.nodeType === 1 && node.nodeName === 'sheet');
  if (sheets.length < 2 || sheets.length > 500 || sheets.some((sheet, index) => Number(sheet.getAttribute('number')) !== index + 1)) throw new RecognitionArchiveError('识别档案页数无效或不足两页。');
  return { pageCount: sheets.length, remainingComplete: sheets.slice(1).every(sheet => sheet.getAttribute('invalid') !== 'true' && /\bPAGE\b/.test(sheet.getElementsByTagName('steps')[0]?.textContent ?? '')), ...(includeFirstState ? { firstInvalidWithoutPage: sheets[0].getAttribute('invalid') === 'true' && !/\bPAGE\b/.test(sheets[0].getElementsByTagName('steps')[0]?.textContent ?? '') } : {}) };
}
export type EngineOptions = { root: string; bin?: string; timeoutMs?: number; probeTimeoutMs?: number };

/** Arguments are never passed through a shell. Kill the whole JVM process group on timeout. */
export function runProcess(command: string, args: string[], options: { timeoutMs: number; cwd: string }): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, JAVA_TOOL_OPTIONS: `${process.env.JAVA_TOOL_OPTIONS ?? ''} -Djava.awt.headless=true`.trim() },
    });
    let output = '';
    let timedOut = false;
    const append = (data: Buffer) => { output = (output + data.toString('utf8')).slice(-32_768); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* process may already have exited */ }
    }, options.timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(new Error(`无法启动 Audiveris：${error.message}`)); });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`Audiveris 超时，已终止进程。限时 ${Math.round(options.timeoutMs / 1000)} 秒。`));
      else resolve({ code: code ?? -1, output });
    });
  });
}

export async function findResult(output: string): Promise<string | undefined> {
  const base = await realpath(output);
  let visited = 0;
  const found: string[] = [];
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > 4) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (++visited > 1000) throw new Error('Audiveris 输出文件过多。');
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(candidate, depth + 1);
      else if (entry.isFile() && /\.(mxl|musicxml|xml)$/i.test(entry.name)) {
        const resolved = await realpath(candidate);
        if (!resolved.startsWith(base + path.sep)) continue;
        const info = await stat(resolved);
        if (info.size > 0 && info.size <= 32 * 1024 * 1024) found.push(resolved);
      }
    }
  }
  await visit(base, 0);
  return found.sort((a, b) => (Number(!a.endsWith('.mxl')) - Number(!b.endsWith('.mxl'))) || a.localeCompare(b))[0];
}

export function describeAudiverisFailure(output: string, code: number): string {
  const lines = output.split(/\r?\n/);
  const pages: number[] = [];
  for (const line of lines) {
    if (!/No regularly spaced lines found/.test(line)) continue;
    const page = line.match(/\[[^\]]*#(\d+)\]/)?.[1];
    if (page && !pages.includes(Number(page))) pages.push(Number(page));
  }
  if (/No regularly spaced lines found/.test(output)) {
    const location = pages.length ? `第 ${pages.join('、')} 页` : '部分页面';
    return `${location}未找到规律的五线谱，可能是封面或空白页。请移除封面或仅上传乐谱页。此次没有导出完整识别结果，原始文件仍保留。`;
  }
  if (/OutOfMemoryError|Java heap space|GC overhead limit/.test(output)) return '本机识谱引擎内存不足，未导出完整结果。请将长谱拆成较小的文件后重试，原始文件仍保留。';
  if (/Could not initialize TessBaseAPI|Failed loading language|Missing support for/.test(output)) return '文字识别模型未能正常工作。请运行 npm run doctor -- --ocr-smoke 检查；本次未导出完整识别结果。';
  const root = lines.find(line => /Caused by:/.test(line) && !/ExecutionException/.test(line)) ?? lines.find(line => /Error processing stub|Exception occurred/.test(line));
  const page = root?.match(/\[[^\]]*#(\d+)\]/)?.[1];
  const location = page ? `第 ${page} 页的` : '';
  if (/NullPointerException|IllegalStateException|IllegalArgumentException|Error in reaching step PAGE|Error processing stub/.test(output)) return `Audiveris ${location}排版或节奏分析失败，未导出完整结果。这不代表图片一定不清晰；原始文件和详细诊断日志仍保留。`;
  return `Audiveris 未能完成识别，退出码 ${code}。原始文件和详细诊断日志仍保留；请检查文件格式或稍后重试。`;
}

async function failureLog(outputDirectory: string, fallback: string): Promise<string> {
  // Audiveris stdout is bounded to its tail. Read its complete local log so the
  // first failed page is not replaced by the final generic PAGE exception.
  try {
    const base = await realpath(outputDirectory);
    const logs: Array<{ file: string; modified: number }> = [];
    for (const name of await readdir(base)) {
      if (!name.endsWith('.log')) continue;
      const file = path.join(base, name); const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) continue;
      const actual = await realpath(file);
      if (!actual.startsWith(base + path.sep)) continue;
      logs.push({ file: actual, modified: info.mtimeMs });
    }
    logs.sort((a, b) => b.modified - a.modified);
    if (logs[0]) return `${await readFile(logs[0].file, 'utf8')}\n${fallback}`;
  } catch { /* Fall back to captured process output without leaking filesystem errors. */ }
  return fallback;
}

export function createAudiverisEngine(options: EngineOptions): RecognitionEngine {
  const bin = options.bin ?? process.env.AUDIVERIS_BIN ?? path.join(options.root, '.tools/audiveris/launch');
  let cached: EngineHealth | undefined;
  let checkedAt = 0;
  let checking: Promise<EngineHealth> | undefined;
  async function probe(): Promise<EngineHealth> {
    try {
      // A bare AUDIVERIS_BIN may resolve through PATH; absolute paths must be executable.
      if (path.isAbsolute(bin)) await access(bin, constants.X_OK);
      const result = await runProcess(bin, ['-help'], { timeoutMs: options.probeTimeoutMs ?? 30_000, cwd: options.root });
      if (result.code !== 0 || !/Audiveris/i.test(result.output)) throw new Error(`batch 帮助未成功返回，退出码 ${result.code}`);
      const languages = await runProcess(bin, ['-batch'], { timeoutMs: options.probeTimeoutMs ?? 30_000, cwd: options.root });
      if (languages.code !== 0 || !/Installed OCR languages:[^\r\n]*\beng\b/.test(languages.output)) throw new Error('缺少可用的英文文字识别模型，请运行 npm run setup:omr -- --ocr-only。');
      const versionResult = await runProcess(bin, ['-version'], { timeoutMs: options.probeTimeoutMs ?? 30_000, cwd: options.root });
      const version = versionResult.output.match(/Version:\s*v?(\d+\.\d+(?:\.\d+)?)/i)?.[1] ?? versionResult.output.match(/Audiveris\s+(?:version\s+)?v?(\d+\.\d+(?:\.\d+)?)/i)?.[1];
      return { available: true, name: 'Audiveris', ...(version ? { version } : {}), detail: '本机 Audiveris batch 可用；识别文件不会上传到外部服务。' };
    } catch (error) {
      return { available: false, name: 'Audiveris', detail: `Audiveris 不可用。请运行 npm run setup:omr，再运行 npm run doctor；或设置 AUDIVERIS_BIN 为可执行文件。${error instanceof Error ? error.message : ''}` };
    }
  }
  const engine: RecognitionEngine = {
    async health() {
      if (cached && Date.now() - checkedAt < 10_000) return cached;
      checking ??= probe().then((value) => { cached = value; checkedAt = Date.now(); return value; }).finally(() => { checking = undefined; });
      return checking;
    },
    async recognize(input, output, selection) {
      await mkdir(output, { recursive: true, mode: 0o700 });
      const args = ['-batch', '-constant', 'org.audiveris.omr.sig.inter.AbstractTimeInter.optionalTimes=6/4, 7/8, 6/2'];
      if (selection?.skipFirstPage) {
        if (!Number.isInteger(selection.pageCount) || selection.pageCount! < 2 || selection.pageCount! > 500) throw new Error('无法确认原稿页数，不能安全跳过第一页。');
        args.push('-sheets', `2-${selection.pageCount}`);
      }
      let archiveInput: string | undefined;
      if (selection?.archive) {
        // Audiveris saves .omr and its export next to the input archive despite
        // -output. Keep its disposable copy INSIDE the result directory.
        await inspectRecognitionArchive(selection.archive);
        archiveInput = path.join(output, 'recovery.omr');
        await writeFile(archiveInput, await readFile(selection.archive), { mode: 0o600, flag: 'wx' });
      } else args.push('-transcribe');
      args.push('-export', '-output', output, '--', archiveInput ?? input);
      const result = await runProcess(bin, args, { timeoutMs: options.timeoutMs ?? 5 * 60_000, cwd: options.root });
      if (result.code !== 0) {
        const diagnostic = await failureLog(output, result.output);
        const firstFailure = diagnostic.split(/\r?\n/).find(line => /Error processing stub|Exception occurred|Caused by:|OutOfMemoryError/.test(line));
        if (!selection && firstFailure && /\[[^\]]*#1\]/.test(firstFailure) && /No regularly spaced lines found/.test(firstFailure)) {
          let archiveState: Awaited<ReturnType<typeof inspectRecognitionArchive>> | undefined;
          const base = await realpath(output);
          const archive = path.join(base, `${path.basename(input, path.extname(input))}.omr`);
          try {
            await assertPlainPath(base, archive);
            archiveState = await inspectRecognitionArchive(archive, true);
          } catch { /* Unsafe/missing/incomplete archive is not an automatic recovery candidate. */ }
          if (archiveState?.firstInvalidWithoutPage && archiveState.remainingComplete) {
            const recoveryOutput = path.join(base, 'autocover');
            // Reject pre-existing symlink ancestors before making disposable output.
            try { await assertPlainPath(await realpath(output), recoveryOutput); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
            const recovered = await engine.recognize(input, recoveryOutput, { skipFirstPage: true, pageCount: archiveState.pageCount, archive });
            const warning = `已自动跳过未检测到五线谱的第 1 页，仅导出已完成识别的第 2–${archiveState.pageCount} 页。完整原稿保留，请对照原稿确认第一页确为封面或空白页。`;
            return { ...recovered, warnings: [warning, ...recovered.warnings.filter(item => !/已按你的选择跳过/.test(item))], skippedPages: [1], pageCount: archiveState.pageCount, autoSkippedCover: true };
          }
        }
        throw new Error(describeAudiverisFailure(diagnostic, result.code));
      }
      const file = await findResult(output);
      if (!file) throw new Error('Audiveris 未导出 MusicXML。请使用清晰、完整的印刷乐谱；手写谱和复杂版面可能无法识别。');
      const warnings = ['光学识谱可能误读音高、节奏、拍号和声部。请对照原谱校对后练习。'];
      if (selection?.skipFirstPage) warnings.unshift(`已按你的选择跳过原稿第 1 页，仅处理第 2–${selection.pageCount} 页。原稿完整保留；请确认第一页没有需要练习的乐谱。`);
      const diagnostic = await failureLog(output, result.output);
      if (/Missing support for|Could not initialize TessBaseAPI|Failed loading language/.test(diagnostic)) warnings.push('文字识别模型未能正常工作，曲名、声部名、歌词和速度文字可能缺失。请运行 npm run doctor -- --ocr-smoke 检查。');
      if (/Error visiting MetronomeInter|No beat unit in metronome line/.test(diagnostic)) warnings.push('引擎未能导出部分速度文字或节拍器记号，不能把识别结果中的速度视为原谱速度，请对照原稿设置。');
      else if (/Error visiting|Error processing stub|NullPointerException/.test(diagnostic)) warnings.push('引擎在导出时报告了内部异常，部分谱面记号可能缺失。请逐页对照原稿，不要将此结果视为完整准确转录。');
      return { file, warnings };
    },
  };
  return engine;
}
