import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

const xml = `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Upper</part-name></score-part><score-part id="P2"><part-name>Lower</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>16</duration><type>whole</type></note></measure><measure number="2"><note><pitch><step>D</step><octave>4</octave></pitch><duration>16</duration><type>whole</type></note></measure><measure number="3"><note><pitch><step>E</step><octave>4</octave></pitch><duration>16</duration><type>whole</type></note></measure></part><part id="P2"><measure number="1"><attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>F</sign><line>4</line></clef></attributes><note><pitch><step>C</step><octave>3</octave></pitch><duration>20</duration><type>whole</type></note></measure><measure number="2"><note><pitch><step>D</step><octave>3</octave></pitch><duration>16</duration><type>whole</type></note></measure><measure number="3"><note><pitch><step>E</step><octave>3</octave></pitch><duration>16</duration><type>whole</type></note></measure></part></score-partwise>`;

test('cursor maps canonical bar identity, not accumulated engraving timestamps, and reverses on seek', async () => {
  const compiled = ts.transpileModule(await readFile('src/components/render-compat.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="score" style="position:relative;width:900px"></div>');
    await page.addScriptTag({ path: resolve('node_modules/opensheetmusicdisplay/build/opensheetmusicdisplay.min.js') });
    await page.addScriptTag({ content: `window.__name=(x)=>x;(()=>{const exports={};${compiled};window.helpers=exports;})()` });
    const result = await page.evaluate(async source => {
      const w = window as any;
      const o = new w.opensheetmusicdisplay.OpenSheetMusicDisplay(document.getElementById('score'), { autoResize: false, backend: 'svg' });
      o.EngravingRules.CursorIgnoreRepetitions = true;
      await o.load(source); o.render(); o.cursor.show(); o.cursor.reset();
      const engravedStarts = o.Sheet.SourceMeasures.map((m: any) => m.AbsoluteTimestamp.RealValue * 4);
      // A valid distinct canonical bar timeline, as produced when parts contain inconsistent durations.
      const canonical = [{ number: 1, startBeat: 0, duration: 10 }, { number: 2, startBeat: 10, duration: 4 }, { number: 3, startBeat: 14, duration: 4 }];
      const naive = w.helpers.syncSourceCursor(o, 10);
      const first = w.helpers.syncSourceCursor(o, 10, canonical);
      const last = w.helpers.syncSourceCursor(o, 14, canonical);
      const rewind = w.helpers.syncSourceCursor(o, 0, canonical);
      const mapped = w.helpers.sourceToEngravingBeat(o.Sheet, 11, canonical);
      const reverse = w.helpers.engravingToSourceBeat(o.Sheet, 1, mapped, canonical);
      return { engravedStarts, naive, first, last, rewind, mapped, reverse };
    }, xml);
    assert.equal(result.naive.measure, 3, 'old global sourceBeat/4 lookup selects the next bar');
    assert.equal(result.first.measure, 2); assert.equal(result.first.sourceBeat, 10);
    assert.equal(result.last.measure, 3); assert.equal(result.last.sourceBeat, 14);
    assert.equal(result.rewind.measure, 1); assert.equal(result.rewind.sourceBeat, 0);
    assert.equal(result.mapped, result.engravedStarts[1] + 1); assert.equal(result.reverse, 11);
  } finally { await browser.close(); }
});
