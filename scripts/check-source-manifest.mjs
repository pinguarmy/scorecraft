// Compares source-files.txt with `git ls-files`.
//   node scripts/check-source-manifest.mjs           exit 1 if they differ
//   node scripts/check-source-manifest.mjs --write   regenerate source-files.txt
// New files must be added to git (`git add`) before they show up in the list.
// Outside a git checkout (for example the unpacked source ZIP) the check is skipped.
import { execFile } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const manifestPath = path.join(root, 'source-files.txt');
const write = process.argv.includes('--write');

function git(args) {
  return run('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
}

let tracked;
try {
  const top = (await git(['rev-parse', '--show-toplevel'])).stdout.trim();
  if ((await realpath(top)) !== root) throw new Error('not the repository root');
  // -z keeps unusual file names intact.
  tracked = (await git(['ls-files', '-z'])).stdout.split('\0').filter(Boolean);
} catch {
  console.log('Not a git checkout of ScoreCraft, skipping the source manifest check.');
  process.exit(0);
}
// Plain code-unit order, same as the existing manifest.
tracked.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const text = await readFile(manifestPath, 'utf8');
const lines = text.split(/\r?\n/);
const header = lines.filter((line) => line.startsWith('#'));
const listed = lines.filter((line) => line && !line.startsWith('#'));

if (write) {
  const defaultHeader = ['# Files included in the ScoreCraft source ZIP, one per line.'];
  const out = [...(header.length ? header : defaultHeader), ...tracked].join('\n') + '\n';
  if (out === text) {
    console.log(`source-files.txt is up to date (${tracked.length} files).`);
  } else {
    await writeFile(manifestPath, out);
    console.log(`source-files.txt rewritten (${tracked.length} files).`);
  }
  process.exit(0);
}

const trackedSet = new Set(tracked);
const listedSet = new Set(listed);
const missing = tracked.filter((name) => !listedSet.has(name));
const stale = listed.filter((name) => !trackedSet.has(name));

if (!missing.length && !stale.length) {
  console.log(`source-files.txt matches git ls-files (${tracked.length} files).`);
  process.exit(0);
}
if (missing.length) {
  console.error('Tracked by git but missing from source-files.txt:');
  for (const name of missing) console.error(`  ${name}`);
}
if (stale.length) {
  console.error('Listed in source-files.txt but not tracked by git:');
  for (const name of stale) console.error(`  ${name}`);
}
console.error('Run `npm run check:manifest -- --write` to regenerate it.');
process.exit(1);
