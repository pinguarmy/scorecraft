// Render the actual CC0 MusicXML fixture to a clean image for genuine OMR E2E.
import { chromium } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const xml = await readFile(path.join(root, 'public/samples/first-light.musicxml'), 'utf8');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 2000 }, deviceScaleFactor: 2 });
  await page.setContent(
    '<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;padding:48px;background:white}#score{width:1350px}</style></head><body><div id="score"></div></body></html>',
  );
  await page.addScriptTag({
    path: path.join(root, 'node_modules/opensheetmusicdisplay/build/opensheetmusicdisplay.min.js'),
  });
  const details = await page.evaluate(async (source) => {
    const display = new window.opensheetmusicdisplay.OpenSheetMusicDisplay(document.getElementById('score'), {
      autoResize: false,
      backend: 'svg',
      drawTitle: true,
      drawComposer: true,
      drawPartNames: true,
      drawingParameters: 'default',
    });
    await display.load(source);
    display.render();
    const holder = document.getElementById('score');
    return { width: holder.clientWidth, height: holder.clientHeight, svgCount: holder.querySelectorAll('svg').length };
  }, xml);
  await mkdir(path.join(root, 'public/samples'), { recursive: true });
  await page
    .locator('#score')
    .screenshot({ path: path.join(root, 'public/samples/first-light.png'), animations: 'disabled' });
  console.log(JSON.stringify({ image: 'public/samples/first-light.png', ...details }, null, 2));
} finally {
  await browser.close();
}
