import { browserLaunchOptions } from '../browser.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

const measures = Array.from(
  { length: 56 },
  (_, index) =>
    `<measure number="${index + 1}">${index === 0 ? '<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>' : index % 3 === 0 ? '<print new-system="yes"/>' : ''}<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure>`,
).join('');
const xml = `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Original long cursor check</part-name></score-part></part-list><part id="P1">${measures}</part></score-partwise>`;

test('CSS-scaled long SVG reproduces cursor drift, then screen-CTM alignment fixes seek, scroll and rerender', async () => {
  const compiled = ts.transpileModule(await readFile('src/components/render-compat.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const browser = await chromium.launch(browserLaunchOptions());
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent(
      '<style>*{box-sizing:border-box}#frame{width:1000px;position:relative}#host{width:100%;padding:15px 25px 30px}#host svg{max-width:100%;height:auto}#host>div{max-width:100%}</style><div id="frame"><div style="height:75px">Warning placeholder</div><div id="host"></div></div>',
    );
    await page.addScriptTag({ path: resolve('node_modules/opensheetmusicdisplay/build/opensheetmusicdisplay.min.js') });
    await page.addScriptTag({
      content: `window.__name=(f)=>f;(()=>{const exports={};${compiled};window.helpers=exports;})()`,
    });
    const output = await page.evaluate(async (source) => {
      const w = window as any;
      const osmd = new w.opensheetmusicdisplay.OpenSheetMusicDisplay(document.getElementById('host'), {
        autoResize: false,
        backend: 'svg',
        newSystemFromXML: true,
        cursorsOptions: [
          { type: w.opensheetmusicdisplay.CursorType.ThinLeft, color: '#bd4d35', alpha: 0.85, follow: false },
        ],
      });
      osmd.EngravingRules.CursorIgnoreRepetitions = true;
      await osmd.load(source);
      osmd.render();
      osmd.cursor.show();
      osmd.cursor.reset();
      w.helpers.syncSourceCursor(osmd, 45 * 4 + 1.5);
      osmd.cursor.update();
      function geometry() {
        const image = osmd.cursor.cursorElement;
        const svg = image.parentElement.querySelector('svg');
        const ctm = svg.getScreenCTM();
        const gm = osmd.GraphicSheet.MeasureList[osmd.cursor.iterator.CurrentMeasureIndex][0];
        const system = gm.ParentMusicSystem;
        const first = system.StaffLines[0];
        const last = system.StaffLines.at(-1);
        const top = system.PositionAndShape.AbsolutePosition.y + first.PositionAndShape.RelativePosition.y;
        const bottom =
          system.PositionAndShape.AbsolutePosition.y + last.PositionAndShape.RelativePosition.y + last.StaffHeight;
        const expectedTop = new DOMPoint(0, top * 10).matrixTransform(ctm).y;
        const expectedBottom = new DOMPoint(0, bottom * 10).matrixTransform(ctm).y;
        const rect = image.getBoundingClientRect();
        return {
          scale: ctm.a,
          topError: rect.top - expectedTop,
          bottomError: rect.bottom - expectedBottom,
          top: rect.top,
          height: rect.height,
          measure: osmd.cursor.iterator.CurrentMeasureIndex + 1,
        };
      }
      const native = geometry();
      w.helpers.alignCursorToSvg(osmd);
      const fixed = geometry();
      window.scrollTo(0, 1000);
      osmd.cursor.update();
      w.helpers.alignCursorToSvg(osmd);
      const scrolled = geometry();
      document.getElementById('frame')!.style.width = '800px';
      osmd.render();
      osmd.cursor.update();
      w.helpers.alignCursorToSvg(osmd);
      const resized = geometry();
      const intra = [];
      for (const beat of [45 * 4 + 0.125, 45 * 4 + 1.5, 49 * 4 + 2.875, 55 * 4 + 0.5, 20 * 4 + 1.25]) {
        w.helpers.syncSourceCursor(osmd, beat);
        intra.push(geometry());
      }
      return { native, fixed, scrolled, resized, intra };
    }, xml);
    assert.ok(output.native.scale < 0.99, 'fixture must actually shrink the SVG');
    assert.ok(output.native.topError > 100, `must reproduce accumulated visible drift, got ${output.native.topError}`);
    for (const sample of [output.fixed, output.scrolled, output.resized, ...output.intra]) {
      assert.ok(Math.abs(sample.topError) < 2, `cursor top follows actual SVG system: ${JSON.stringify(sample)}`);
      assert.ok(Math.abs(sample.bottomError) < 2, `cursor bottom follows actual SVG system: ${JSON.stringify(sample)}`);
    }
  } finally {
    await browser.close();
  }
});
