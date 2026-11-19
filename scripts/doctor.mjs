#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs';
import { readFile, mkdtemp, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { ENGLISH_MODEL_SHA256 } from './setup-audiveris.mjs';
import { resolve, dirname, join, isAbsolute } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');
const DEFAULT_BIN = join(ROOT_DIR, '.tools', 'audiveris', 'launch');

async function checkAudiveris(binPath) {
  if (isAbsolute(binPath) && !existsSync(binPath)) {
    return {
      available: false,
      path: binPath,
      error: `Executable not found at ${binPath}`
    };
  }

  try {
    // Bare command names use PATH, matching the server's execFile/spawn behavior.
    const stats = isAbsolute(binPath) ? statSync(binPath) : undefined;
    if (stats && (!stats.isFile() || (stats.mode & 0o111) === 0)) {
      return {
        available: false,
        path: binPath,
        error: `File exists at ${binPath} but is not marked executable (chmod +x required)`
      };
    }

    const { stdout, stderr } = await execFileAsync(binPath, ['-version'], { timeout: 15000 });
    const output = stdout + stderr;
    if (!/Audiveris/i.test(output)) throw new Error('Executable did not identify itself as Audiveris.');
    const versionMatch = output.match(/Version:\s*([^\r\n]+)/i);
    const ocrMatch = output.match(/OCR Engine:\s*([^\r\n]+)/i);

    return {
      available: true,
      path: binPath,
      version: versionMatch ? versionMatch[1].trim() : 'Unknown',
      ocr: ocrMatch ? ocrMatch[1].trim() : 'Unknown',
      raw: output.trim()
    };
  } catch (err) {
    return {
      available: false,
      path: binPath,
      error: err?.message || String(err)
    };
  }
}

export async function verifyEnglishModel(directory) {
  const bytes = await readFile(join(directory, 'eng.traineddata'));
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== ENGLISH_MODEL_SHA256) throw new Error('English OCR data missing or incompatible. Run npm run setup:omr -- --ocr-only. Audiveris requires legacy tessdata, not tessdata_fast.');
  return hash;
}
async function smokeOcr(binPath) {
  const diagnostics = join(ROOT_DIR, '.tools', 'ocr-doctor');
  await mkdir(diagnostics, { recursive: true });
  const output = await mkdtemp(join(diagnostics, 'smoke-'));
  const { stdout, stderr } = await execFileAsync(binPath, ['-batch', '-transcribe', '-export', '-output', output, '--', join(ROOT_DIR, 'public/samples/first-light.png')], { timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  if (/Could not initialize TessBaseAPI|Failed loading language|Missing support for/.test(stdout + stderr)) throw new Error('OCR initialized without working English recognition.');
  const { readdir } = await import('node:fs/promises');
  const mxl = (await readdir(output)).find(name => name.endsWith('.mxl'));
  if (!mxl) throw new Error('OCR smoke did not export MusicXML.');
  const entries = unzipSync(new Uint8Array(await readFile(join(output, mxl))));
  const xml = Object.entries(entries).filter(([name]) => name.endsWith('.xml') && !name.startsWith('META-INF/')).map(([, value]) => strFromU8(value)).join('');
  if (!/First\s+Light/i.test(xml)) throw new Error('OCR smoke did not recognize the known CC0 title First Light.');
  return output;
}
async function main() {
  console.log('=== ScoreCraft System Doctor ===\n');

  const binOverride = process.env.AUDIVERIS_BIN;
  const targetBin = binOverride || DEFAULT_BIN;

  console.log(`Audiveris Binary Source: ${binOverride ? 'AUDIVERIS_BIN environment override' : 'Default pinned .tools'}`);
  console.log(`Audiveris Target Path:   ${targetBin}`);

  const status = await checkAudiveris(targetBin);

  if (status.available) {
    console.log('\n[PASS] Audiveris OMR Engine is READY');
    console.log(`- Version:    ${status.version}`);
    console.log(`- OCR Engine: ${status.ocr}`);
    console.log(`- Binary:     ${status.path}`);
    if (!binOverride) {
      await verifyEnglishModel(join(ROOT_DIR, '.tools/audiveris/tessdata'));
      const { stdout, stderr } = await execFileAsync(targetBin, ['-batch'], { timeout: 15000 });
      if (!/Installed OCR languages:[^\r\n]*\beng\b/.test(stdout + stderr)) throw new Error('Audiveris did not list English OCR support. Run npm run setup:omr -- --ocr-only.');
      console.log('- English:    pinned legacy model checksum verified; language eng available. Recognition accuracy still requires review.');
    } else console.log('- English:    custom executable, model checksum not managed; run --ocr-smoke for actual text recognition.');
    if (process.argv.includes('--ocr-smoke')) console.log(`- OCR smoke:  recognized known CC0 title First Light; diagnostics ${await smokeOcr(targetBin)}`);
    console.log('\nCommand syntax for batch processing:');
    console.log(`  ${targetBin} -batch -transcribe -export -output <output_dir> -- <input_file>`);
    process.exit(0);
  } else {
    console.error('\n[FAIL] Audiveris OMR Engine is NOT AVAILABLE');
    console.error(`- Error:  ${status.error}`);
    console.error('\nActionable instructions to resolve:');
    if (!binOverride) {
      console.error('  1. Run the local automated installer:');
      console.error('       npm run setup:omr');
      console.error('     (Downloads pinned Audiveris 5.11.0 into .tools/audiveris without root/system changes)');
    } else {
      console.error('  1. Verify the file path specified in AUDIVERIS_BIN exists and is executable:');
      console.error(`       chmod +x "${targetBin}"`);
      console.error('  2. Or unset AUDIVERIS_BIN to use the local .tools installer:');
      console.error('       unset AUDIVERIS_BIN && npm run setup:omr');
    }
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(err => {
  console.error('[FAIL] Doctor:', err.message ?? err);
  process.exitCode = 1;
});
