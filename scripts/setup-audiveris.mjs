#!/usr/bin/env node
import { createWriteStream, existsSync, mkdirSync, rmSync, createReadStream, renameSync, lstatSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname, join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');
const TOOLS_DIR = join(ROOT_DIR, '.tools');
const AUDIVERIS_DIR = join(TOOLS_DIR, 'audiveris');
const DOWNLOAD_DIR = join(TOOLS_DIR, 'downloads');

const ASSET_URL = 'https://github.com/Audiveris/audiveris/releases/download/5.11.0/Audiveris-5.11.0-macosx-arm64.dmg';
const EXPECTED_SHA256 = '17491af8b6d40153b031dd1f0815e37213f0999ef23f10586af46706e59b2eb6';
const DMG_PATH = join(DOWNLOAD_DIR, 'Audiveris-5.11.0-macosx-arm64.dmg');
export const ENGLISH_MODEL_URL = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata/ced78752cc61322fb554c280d13360b35b8684e4/eng.traineddata';
export const ENGLISH_MODEL_SHA256 = 'daa0c97d651c19fba3b25e81317cd697e9908c8208090c94c3905381c23fc047';
const ENGLISH_LICENSE_URL = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata/ced78752cc61322fb554c280d13360b35b8684e4/LICENSE';

function assertWithinTools(targetPath) {
  const resolved = resolve(targetPath);
  if (!resolved.startsWith(TOOLS_DIR + '/') && resolved !== TOOLS_DIR) {
    throw new Error(`Security violation: Target path ${resolved} is outside ${TOOLS_DIR}`);
  }
  // Reject symlink ancestors so lexical .tools paths cannot escape the project.
  for (let current = resolved; current !== ROOT_DIR; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Refusing symlink in installation path: ${current}`);
    if (dirname(current) === current) throw new Error('Installation path does not reach project root');
  }
  return resolved;
}
function safeRemove(target) {
  const checked = assertWithinTools(target);
  if (checked === TOOLS_DIR) throw new Error('Refusing to remove the .tools root');
  rmSync(checked, { recursive: true, force: true });
}
function safeRename(source, destination) {
  assertWithinTools(source);
  assertWithinTools(destination);
  renameSync(source, destination);
}

async function computeSha256(filePath) {
  return new Promise((res, rej) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => res(hash.digest('hex')));
    stream.on('error', rej);
  });
}

async function downloadFile(url, destPath) {
  assertWithinTools(destPath);
  console.log(`[setup-audiveris] Downloading asset from ${url}...`);
  // 3-minute timeout for download
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 180000);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
    }
    mkdirSync(dirname(destPath), { recursive: true });
    const fileStream = createWriteStream(destPath);
    await pipeline(res.body, fileStream);
    console.log(`[setup-audiveris] Download complete: ${destPath}`);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function mountDmg(dmgPath, mountPoint) {
  assertWithinTools(mountPoint);
  console.log(`[setup-audiveris] Attaching DMG to ${mountPoint} (read-only)...`);

  return new Promise((res, rej) => {
    const child = spawn('hdiutil', [
      'attach',
      dmgPath,
      '-readonly',
      '-nobrowse',
      '-noautoopen',
      '-mountpoint',
      mountPoint
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      rej(new Error('hdiutil attach timed out after 30s'));
    }, 30000);

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    // Automatically accept embedded license agreement by writing Y\n
    child.stdin.write('Y\n');
    child.stdin.end();

    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        res({ stdout, stderr });
      } else {
        rej(new Error(`hdiutil attach failed with code ${code}:\n${stderr}\n${stdout}`));
      }
    });

    child.on('error', err => {
      clearTimeout(timer);
      rej(err);
    });
  });
}

async function detachDmg(mountPoint) {
  assertWithinTools(mountPoint);
  console.log(`[setup-audiveris] Detaching ${mountPoint}...`);
  // Fail visibly rather than deleting a still-mounted directory.
  await execFileAsync('hdiutil', ['detach', mountPoint, '-quiet'], { timeout: 15000 });
}

async function installEnglishModel(directory) {
  assertWithinTools(directory);
  const tessdata = join(directory, 'tessdata');
  assertWithinTools(tessdata); mkdirSync(tessdata, { recursive: true });
  const model = join(tessdata, 'eng.traineddata');
  assertWithinTools(model);
  if (!existsSync(model) || await computeSha256(model) !== ENGLISH_MODEL_SHA256) {
    const temporary = join(tessdata, `eng-${Date.now()}.tmp`);
    try {
      await downloadFile(ENGLISH_MODEL_URL, temporary);
      const hash = await computeSha256(temporary);
      if (hash !== ENGLISH_MODEL_SHA256) throw new Error(`English OCR model checksum mismatch: ${hash}`);
      safeRename(temporary, model);
    } finally { if (existsSync(temporary)) safeRemove(temporary); }
  }
  const license = join(tessdata, 'LICENSE');
  assertWithinTools(license);
  if (!existsSync(license)) await downloadFile(ENGLISH_LICENSE_URL, license);
  writeFileSync(join(tessdata, 'SOURCE.txt'), `Tesseract English legacy + LSTM model, Apache-2.0\n${ENGLISH_MODEL_URL}\nSHA256 ${ENGLISH_MODEL_SHA256}\n`);
  console.log(`[setup-audiveris] English OCR model verified: ${ENGLISH_MODEL_SHA256}`);
}

export function buildLauncherScript() {
  return `#!/bin/sh
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/Audiveris.app"
USER_DATA_DIR="$DIR/data"
USER_CONFIG_DIR="$DIR/config"
USER_CACHE_DIR="$DIR/cache"

mkdir -p "$USER_DATA_DIR" "$USER_CONFIG_DIR" "$USER_CACHE_DIR"
# Audiveris WellKnowns uses the HOME environment, not Java's user.home.
export HOME="$USER_DATA_DIR"
export TESSDATA_PREFIX="$DIR/tessdata"
if [ ! -s "$TESSDATA_PREFIX/eng.traineddata" ]; then
  echo "English OCR data missing. Run npm run setup:omr -- --ocr-only" >&2
  exit 1
fi

JAVA_BIN="$APP/Contents/runtime/Contents/Home/bin/java"
MACOS_BIN="$APP/Contents/MacOS/Audiveris"

if [ -x "$JAVA_BIN" ] && [ -d "$APP/Contents/app" ]; then
  exec "$JAVA_BIN" \\
    -Djpackage.app-version=5.11.0 \\
    --add-exports=java.desktop/sun.awt.image=ALL-UNNAMED \\
    --enable-native-access=ALL-UNNAMED \\
    -Dsun.java2d.uiScale.enabled=true \\
    -Dfile.encoding=UTF-8 \\
    -Djava.awt.headless=true \\
    -Duser.home="$USER_DATA_DIR" \\
    -Daudiveris.data="$USER_DATA_DIR" \\
    -Daudiveris.config="$USER_CONFIG_DIR" \\
    -Daudiveris.cache="$USER_CACHE_DIR" \\
    -Xms256m \\
    -Xmx2g \\
    -cp "$APP/Contents/app/*" \\
    Audiveris \\
    "$@"
else
  echo "[Audiveris Launcher] Error: Bundled JVM or app classpath missing in $APP; rerun npm run setup:omr" >&2
  exit 1
fi
`;
}

async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('Pinned setup supports macOS arm64 only. Set AUDIVERIS_BIN to your separately installed Audiveris executable.');
  }
  console.log('=== Audiveris Local Pinned Setup ===');
  console.log(`Target directory: ${AUDIVERIS_DIR}`);
  assertWithinTools(AUDIVERIS_DIR);
  mkdirSync(TOOLS_DIR, { recursive: true });
  mkdirSync(DOWNLOAD_DIR, { recursive: true });
  if (process.argv.includes('--ocr-only')) {
    if (!existsSync(join(AUDIVERIS_DIR, 'Audiveris.app'))) throw new Error('Install Audiveris first with npm run setup:omr');
    await installEnglishModel(AUDIVERIS_DIR);
    const launcher = join(AUDIVERIS_DIR, 'launch');
    assertWithinTools(launcher);
    const temporary = join(AUDIVERIS_DIR, 'launch.tmp');
    assertWithinTools(temporary);
    writeFileSync(temporary, buildLauncherScript(), { mode: 0o755 });
    await execFileAsync(temporary, ['-version'], { timeout: 30000 });
    safeRename(temporary, launcher);
    console.log('[setup-audiveris] English OCR configured without replacing app or existing configuration.');
    return;
  }

  // 1. Download & verify SHA256
  let validDmg = false;
  if (existsSync(DMG_PATH)) {
    console.log('[setup-audiveris] Checking existing DMG checksum...');
    const hash = await computeSha256(DMG_PATH);
    if (hash.toLowerCase() === EXPECTED_SHA256.toLowerCase()) {
      console.log(`[setup-audiveris] Verified existing DMG SHA256: ${hash}`);
      validDmg = true;
    } else {
      console.log(`[setup-audiveris] DMG hash mismatch (${hash}), deleting old file.`);
      safeRemove(DMG_PATH);
    }
  }

  if (!validDmg) {
    const tempDmg = join(DOWNLOAD_DIR, `Audiveris-5.11.0-${Date.now()}.tmp`);
    await downloadFile(ASSET_URL, tempDmg);
    const hash = await computeSha256(tempDmg);
    if (hash.toLowerCase() !== EXPECTED_SHA256.toLowerCase()) {
      safeRemove(tempDmg);
      throw new Error(`Checksum mismatch! Expected: ${EXPECTED_SHA256}\nReceived: ${hash}`);
    }
    console.log(`[setup-audiveris] SHA256 verified successfully: ${hash}`);
    safeRename(tempDmg, DMG_PATH);
  }

  // 2. Mount DMG
  const mountPoint = join(TOOLS_DIR, `mount-${Date.now()}`);
  mkdirSync(mountPoint, { recursive: true });

  const stagingDir = join(TOOLS_DIR, `staging-${Date.now()}`);
  assertWithinTools(stagingDir);
  mkdirSync(stagingDir, { recursive: true });

  let mounted = false;
  try {
    await mountDmg(DMG_PATH, mountPoint);
    mounted = true;

    const sourceApp = join(mountPoint, 'Audiveris.app');
    if (!existsSync(sourceApp)) {
      throw new Error(`Audiveris.app not found inside mounted DMG at ${sourceApp}`);
    }

    const stagingApp = join(stagingDir, 'Audiveris.app');
    console.log(`[setup-audiveris] Copying Audiveris.app into staging area...`);
    await execFileAsync('cp', ['-aR', sourceApp, stagingApp], { timeout: 60000 });

    const launcherPath = join(stagingDir, 'launch');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(launcherPath, buildLauncherScript(), { mode: 0o755 });

    await installEnglishModel(stagingDir);

    // 3. Verify in staging area BEFORE replacing existing installation
    console.log(`[setup-audiveris] Verifying staged launcher with -help...`);
    const helpCheck = await execFileAsync(launcherPath, ['-help'], { timeout: 30000 });
    if (!helpCheck.stdout.includes('Syntax:') || !helpCheck.stdout.includes('audiveris [OPTIONS]')) {
      throw new Error(`Staged launcher probe failed with output:\n${helpCheck.stdout}\n${helpCheck.stderr}`);
    }
    console.log('[setup-audiveris] Staged launcher -help probe verified successfully.');

    console.log(`[setup-audiveris] Verifying staged launcher with -version...`);
    const versionCheck = await execFileAsync(launcherPath, ['-version'], { timeout: 30000 });
    if (!versionCheck.stdout.includes('Audiveris') || !versionCheck.stdout.includes('5.11.0')) {
      throw new Error(`Staged launcher -version failed:\n${versionCheck.stdout}\n${versionCheck.stderr}`);
    }
    console.log('[setup-audiveris] Staged launcher -version verified successfully.');

    // Preserve local settings/cache when reinstalling; never copy host user config.
    if (existsSync(AUDIVERIS_DIR)) {
      for (const name of ['data', 'config', 'cache']) {
        const source = join(AUDIVERIS_DIR, name);
        const destination = join(stagingDir, name);
        assertWithinTools(source); assertWithinTools(destination);
        if (existsSync(source)) await execFileAsync('cp', ['-aR', source + '/.', destination], { timeout: 60000 });
      }
    }
    // 4. Safe atomic replacement
    assertWithinTools(AUDIVERIS_DIR);
    if (existsSync(AUDIVERIS_DIR)) {
      const backupDir = join(TOOLS_DIR, `audiveris-old-${Date.now()}`);
      assertWithinTools(backupDir);
      console.log(`[setup-audiveris] Moving existing installation to temporary backup...`);
      safeRename(AUDIVERIS_DIR, backupDir);
      try {
        safeRename(stagingDir, AUDIVERIS_DIR);
        safeRemove(backupDir);
      } catch (err) {
        console.error('[setup-audiveris] Replacement failed, restoring backup...', err);
        if (existsSync(backupDir) && !existsSync(AUDIVERIS_DIR)) {
          safeRename(backupDir, AUDIVERIS_DIR);
        }
        throw err;
      }
    } else {
      safeRename(stagingDir, AUDIVERIS_DIR);
    }

    console.log(`[setup-audiveris] Successfully installed Audiveris to ${AUDIVERIS_DIR}`);
    console.log(`[setup-audiveris] Launcher: ${join(AUDIVERIS_DIR, 'launch')}`);
  } finally {
    if (mounted) {
      await detachDmg(mountPoint);
    }
    // On an interrupted attach, do not recursively delete a possibly mounted volume.
    if (mounted && existsSync(mountPoint)) safeRemove(mountPoint);
    if (!mounted) console.warn(`[setup-audiveris] Attach did not complete. If a volume remains, detach it with: hdiutil detach ${JSON.stringify(mountPoint)}`);
    if (existsSync(stagingDir)) safeRemove(stagingDir);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(err => {
  console.error('[setup-audiveris] Error during setup:', err);
  process.exitCode = 1;
});
