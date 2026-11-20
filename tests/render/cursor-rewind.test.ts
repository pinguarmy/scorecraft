import { browserLaunchOptions } from '../browser.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Original 60-bar example. Repeated incomplete endings reproduce an OMR-like
// forward jump even when OSMD's CursorIgnoreRepetitions is true.
const bars = Array.from(
  { length: 60 },
  (_, index) =>
    `<measure number="${index + 1}">${index === 0 ? '<attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>' : ''}${[1, 21, 56].includes(index) ? '<barline location="left"><ending number="1" type="start"/></barline>' : ''}${index % 3 === 0 ? '<print new-system="yes"/>' : ''}<note><rest/><duration>4</duration><voice>1</voice><type>quarter</type></note><note><pitch><step>C</step><octave>4</octave></pitch><duration>12</duration><voice>1</voice><type>half</type><dot/></note><backup><duration>16</duration></backup><note><pitch><step>E</step><octave>4</octave></pitch><duration>16</duration><voice>2</voice><type>whole</type></note></measure>`,
).join('');
const xml = `<score-partwise version="4.0"><part-list><score-part id="P"><part-name>Original rewind check</part-name></score-part></part-list><part id="P">${bars}</part></score-partwise>`;

test('source-order cursor cannot follow an ending jump and rewinds from late bars or end without changing repeat data', async () => {
  const compiled = ts.transpileModule(await readFile('src/components/render-compat.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const browser = await chromium.launch(browserLaunchOptions());
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.setContent(
      '<style>*{box-sizing:border-box}#frame{width:1000px;position:relative}#host{width:100%;padding:15px 25px 30px}#host svg{max-width:100%;height:auto}#host>div{max-width:100%}</style><div id="frame"><div id="host"></div></div>',
    );
    await page.addScriptTag({ path: 'node_modules/opensheetmusicdisplay/build/opensheetmusicdisplay.min.js' });
    await page.addScriptTag({
      content: `window.__name=f=>f;(()=>{const exports={};${compiled};window.helpers=exports;})()`,
    });
    const output = await page.evaluate(async (source) => {
      const w = window as any;
      const osmd = new w.opensheetmusicdisplay.OpenSheetMusicDisplay(document.getElementById('host'), {
        autoResize: false,
        backend: 'svg',
        newSystemFromXML: true,
        cursorsOptions: [{ type: 1, color: '#bd4d35', alpha: 0.85, follow: false }],
      });
      osmd.EngravingRules.CursorIgnoreRepetitions = true;
      await osmd.load(new DOMParser().parseFromString(source, 'application/xml'));
      osmd.render();
      osmd.cursor.show();
      osmd.cursor.reset();
      const signatures = () =>
        osmd.Sheet.SourceMeasures.map((measure: any) => [
          measure.FirstRepetitionInstructions.map((entry: any) => entry),
          measure.LastRepetitionInstructions.map((entry: any) => entry),
        ]);
      const before = signatures();
      osmd.cursor.iterator.moveToNextVisibleVoiceEntry(false);
      const nativeFirstNext = osmd.cursor.iterator.CurrentMeasureIndex + 1;
      // Cross the first measure boundary with unadapted upstream traversal.
      while (osmd.cursor.iterator.CurrentMeasureIndex === 0) osmd.cursor.iterator.moveToNextVisibleVoiceEntry(false);
      const nativeJump = osmd.cursor.iterator.CurrentMeasureIndex + 1;
      osmd.cursor.reset();
      const canonical = Array.from({ length: 60 }, (_, i) => ({ number: i + 1, startBeat: i * 4, duration: 4 }));
      function sample(measure: number, offset = 0.375) {
        const result = w.helpers.syncSourceCursor(osmd, (measure - 1) * 4 + offset, canonical);
        const it = osmd.cursor.iterator;
        const image = osmd.cursor.cursorElement,
          svg = image.parentElement.querySelector('svg'),
          ctm = svg.getScreenCTM();
        const system = osmd.GraphicSheet.MeasureList[it.CurrentMeasureIndex][0].ParentMusicSystem;
        const first = system.StaffLines[0],
          last = system.StaffLines.at(-1);
        const top = system.PositionAndShape.AbsolutePosition.y + first.PositionAndShape.RelativePosition.y;
        const bottom =
          system.PositionAndShape.AbsolutePosition.y + last.PositionAndShape.RelativePosition.y + last.StaffHeight;
        const rect = image.getBoundingClientRect();
        return {
          requested: measure,
          ...result,
          topError: rect.top - new DOMPoint(0, top * 10).matrixTransform(ctm).y,
          bottomError: rect.bottom - new DOMPoint(0, bottom * 10).matrixTransform(ctm).y,
          nativeWidth: Number(image.getAttribute('width')),
        };
      }
      const samples = [sample(4), sample(55), sample(60), sample(4), sample(53), sample(4)];
      // Exercise the true upstream EndReached flag, not just the last note.
      while (!osmd.cursor.iterator.EndReached) osmd.cursor.iterator.moveToNextVisibleVoiceEntry(false);
      const wasEnd = osmd.cursor.iterator.EndReached;
      samples.push(sample(4));
      const after = signatures();
      const restored = before.every((pair: any[], i: number) =>
        pair.every(
          (entries: any[], side: number) =>
            entries.length === after[i][side].length && entries.every((entry, j) => entry === after[i][side][j]),
        ),
      );
      const writtenRepeat = source
        .replace(/<barline location="left"><ending number="1" type="start"\/><\/barline>/g, '')
        .replace(
          '<measure number="1">',
          '<measure number="1"><barline location="left"><repeat direction="forward"/></barline>',
        )
        .replace(
          '</measure></part>',
          '<barline location="right"><repeat direction="backward"/></barline></measure></part>',
        );
      await osmd.load(new DOMParser().parseFromString(writtenRepeat, 'application/xml'));
      osmd.render();
      osmd.cursor.show();
      osmd.cursor.reset();
      const writtenSamples = [sample(4), sample(55), sample(60), sample(4), sample(53), sample(4)];
      return {
        nativeFirstNext,
        nativeJump,
        samples,
        writtenSamples,
        wasEnd,
        restored,
        originalMarkupUnchanged:
          source === new XMLSerializer().serializeToString(new DOMParser().parseFromString(source, 'application/xml')),
      };
    }, xml);
    assert.ok(output.nativeJump > 4, `fixture must reproduce native forward jump, got ${output.nativeJump}`);
    assert.equal(output.wasEnd, true);
    assert.equal(output.restored, true, 'original repeat instruction objects and order are restored');
    assert.equal(output.originalMarkupUnchanged, true);
    for (const sample of [...output.samples, ...output.writtenSamples]) {
      assert.equal(sample.measure, sample.requested, JSON.stringify(sample));
      assert.equal(sample.sourceBeat, (sample.requested - 1) * 4);
      assert.ok(Math.abs(sample.topError) < 2, JSON.stringify(sample));
      assert.ok(Math.abs(sample.bottomError) < 2, JSON.stringify(sample));
      assert.equal(sample.nativeWidth, 5);
    }
    console.log(JSON.stringify(output));
  } finally {
    await browser.close();
  }
});
