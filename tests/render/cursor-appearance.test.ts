import { browserLaunchOptions } from '../browser.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { build } from 'esbuild';

// Authored regular score, large enough to produce multiple native A4 pages.
const bars = Array.from({ length: 160 }, (_, index) => `<measure number="${index + 1}">${index === 0 ? '<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>' : ''}<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure>`).join('');
const xml = `<score-partwise version="4.0"><part-list><score-part id="P"><part-name>Original cursor appearance check</part-name></score-part></part-list><part id="P">${bars}</part></score-partwise>`;

test('actual ScoreView retains thin red cursor on initial load, new document, and both follow modes', async () => {
  const bundled = await build({
    stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import ScoreView from './src/components/ScoreView'; import { OpenSheetMusicDisplay, CursorType } from 'opensheetmusicdisplay'; const root = createRoot(document.getElementById('app')); window.mount = (xml, followMode) => root.render(React.createElement(ScoreView, { xml, followMode, followEnabled: false, position: 0, playing: false, selectedNoteId: null, onSelectNote: () => {}, onSeek: () => {} })); const originalSetOptions = OpenSheetMusicDisplay.prototype.setOptions; OpenSheetMusicDisplay.prototype.setOptions = function(options) { window.currentOSMD = this; return originalSetOptions.call(this, options); }; window.OSMD = OpenSheetMusicDisplay; window.CursorType = CursorType;`, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' },
  });
  const browser = await chromium.launch(browserLaunchOptions());
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
    await page.setContent('<style>*{box-sizing:border-box}#app{width:760px;position:relative}.score-render-host{width:100%;padding:15px 25px 30px}.score-render-host svg{max-width:100%;height:auto}.score-render-host>div{max-width:100%}</style><div id="app"></div><div id="legacy"></div>');
    await page.addScriptTag({ content: bundled.outputFiles[0].text });
    const legacy = await page.evaluate(() => {
      const w = window as any;
      const osmd = new w.OSMD(document.getElementById('legacy'), { autoResize: false, cursorsOptions: [{ type: w.CursorType.ThinLeft, color: '#bd4d35', alpha: .85, follow: false }] });
      const before = JSON.parse(JSON.stringify(osmd.cursorsOptions));
      osmd.setOptions({ pageFormat: 'Endless' });
      const after = JSON.parse(JSON.stringify(osmd.cursorsOptions));
      osmd.clear(); return { before, after, standard: w.CursorType.Standard };
    });
    assert.equal(legacy.before[0].color, '#bd4d35');
    assert.equal(legacy.after[0].type, legacy.standard, 'upstream partial options reset cursor style rather than retaining it');
    assert.notEqual(legacy.after[0].color, '#bd4d35');

    const samples = [];
    for (const [index, mode] of ['scroll', 'page', 'scroll', 'page'].entries()) {
      // Changed XML identity also exercises reuse of the same OSMD instance for another score.
      const source = index === 2 ? xml.replace('Original cursor appearance check', 'Another original cursor check') : xml;
      await page.evaluate(({ source, mode }) => (window as any).mount(source, mode), { source, mode });
      await page.waitForFunction(expected => {
        const host = document.querySelector('.score-render-host');
        return host?.getAttribute('aria-label') === (expected === 'page' ? '横向翻页乐谱' : '连续滚动乐谱') && host.getAttribute('data-source-measure') === '1' && !document.querySelector('.score-render-message');
      }, mode);
      const sample = await page.locator('.score-render-host img[id^="cursorImg"]').evaluate(async image => {
        const element = image as HTMLImageElement; await element.decode();
        const canvas = document.createElement('canvas'); canvas.width = element.naturalWidth; canvas.height = element.naturalHeight;
        const context = canvas.getContext('2d')!; context.drawImage(element, 0, 0);
        const rgba = [...context.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data];
        return { nativeWidth: Number(element.getAttribute('width')), renderedWidth: element.getBoundingClientRect().width, rgba, options: (window as any).currentOSMD.cursor.CursorOptions, svgs: document.querySelectorAll('.score-render-host svg').length };
      });
      assert.deepEqual(sample.options, { type: 1, color: '#bd4d35', alpha: .85, follow: false }, `exact cursor configuration in ${mode}`);
      assert.equal(sample.nativeWidth, 5, `thin cursor remains 5 native pixels in ${mode}`);
      // Alpha PNG premultiplication can quantize a decoded RGB channel by one.
      for (const [channel, expected] of [189, 77, 53].entries()) assert.ok(Math.abs(sample.rgba[channel] - expected) <= 1, `signature red pixel channel ${channel} in ${mode}: ${sample.rgba}`);
      assert.ok(sample.rgba[3] >= 215 && sample.rgba[3] <= 218, `alpha remains .85 in ${mode}`);
      if (mode === 'page') assert.ok(sample.svgs > 1, 'real multiple native page SVGs must be exercised');
      samples.push({ mode, ...sample });
    }
    console.log(JSON.stringify({ legacy, samples }));
  } finally { await browser.close(); }
});
