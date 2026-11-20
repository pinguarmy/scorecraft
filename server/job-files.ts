import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * A job path that escapes the jobs directory, goes through a symlink or does not resolve to itself. Callers
 * that read a job's files on the client's behalf can treat it as "this input cannot be read safely".
 */
export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

export const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INPUTS = ['input.pdf', 'input.png', 'input.jpg', 'input.jpeg'] as const;
export function displayName(value: unknown): string {
  if (typeof value !== 'string') return '历史扫描';
  const basename = value.replace(/\\/g, '/').split('/').pop() ?? '';
  return Array.from(basename.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '').trim()).slice(0, 200).join('') || '历史扫描';
}
/** Check each component below a canonical project root, not just the final realpath. */
export async function assertPlainPath(root: string, target: string): Promise<void> {
  const relative = path.relative(root, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new UnsafePathError('本地任务路径越界。');
  if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== root) throw new Error('任务根目录已改变。');
  let current = root;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new UnsafePathError('拒绝访问符号链接任务路径。');
  }
}
export async function prepareDataRoot(root: string, requested: string): Promise<{ root: string; data: string }> {
  const canonical = await realpath(root);
  const relative = path.relative(root, requested);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('任务目录必须位于项目目录内。');
  let current = canonical;
  for (const component of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await assertPlainPath(canonical, current);
    if (!(await lstat(current)).isDirectory()) throw new Error('任务路径不是目录。');
  }
  return { root: canonical, data: current };
}
export async function jobDirectory(root: string, data: string, id: string): Promise<string> {
  if (!JOB_ID.test(id)) throw new Error('无效任务编号。');
  const target = path.resolve(data, id);
  if (path.dirname(target) !== data) throw new UnsafePathError('任务路径越界。');
  await assertPlainPath(root, target);
  if (!(await lstat(target)).isDirectory() || await realpath(target) !== target) throw new Error('任务目录无效。');
  return target;
}
export async function originalFile(root: string, directory: string) {
  await assertPlainPath(root, directory);
  const entries = await readdir(directory);
  for (const name of INPUTS) {
    if (!entries.includes(name)) continue;
    const file = path.join(directory, name);
    await assertPlainPath(root, file);
    const info = await lstat(file);
    if (!info.isFile() || await realpath(file) !== file) throw new UnsafePathError('原始文件路径无效。');
    return { file, name, size: info.size, type: name.endsWith('.pdf') ? 'application/pdf' : name.endsWith('.png') ? 'image/png' : 'image/jpeg' };
  }
  return undefined;
}
export async function openOriginal(root: string, directory: string) {
  const original = await originalFile(root, directory);
  if (!original) return undefined;
  const handle = await open(original.file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('原始文件不是常规文件。');
    await assertPlainPath(root, original.file);
    return { ...original, size: info.size, handle };
  } catch (error) { await handle.close(); throw error; }
}
