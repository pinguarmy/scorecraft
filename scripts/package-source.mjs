import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';

const root = await realpath(fileURLToPath(new URL('../', import.meta.url)));
const manifest = await readFile(path.join(root, 'source-files.txt'), 'utf8');
const paths = manifest.split(/\r?\n/).filter(line => line && !line.startsWith('#'));
const files = Object.create(null);

for (const name of paths) {
  if (name.includes('\\') || name.includes(':') || name.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid source archive path: ${name}`);
  }
  const file = path.join(root, name);
  if (await realpath(file) !== file) throw new Error(`Source archive cannot include symlinks: ${name}`);
  files[`scorecraft/${name}`] = new Uint8Array(await readFile(file));
}

// ZIP stores local time; a fixed local date keeps archives reproducible.
const bytes = zipSync(files, { level: 6, mtime: new Date(2000, 0, 1) });
await mkdir(path.join(root, '.data'), { recursive: true });
await writeFile(path.join(root, '.data/source.zip'), bytes);
console.log(`Source archive: .data/source.zip (${Object.keys(files).length} files, ${bytes.length} bytes)`);
