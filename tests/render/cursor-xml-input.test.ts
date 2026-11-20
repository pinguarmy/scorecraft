import { browserLaunchOptions } from '../browser.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { resolve } from 'node:path';

// Newly authored valid MusicXML intentionally has no optional XML declaration.
const xml = '<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Plain XML check</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes><note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure></part></score-partwise>';

test('valid MusicXML without declaration must be passed as Document, never mistaken for URL', async () => {
  const browser = await chromium.launch(browserLaunchOptions());
  try {
    const page = await browser.newPage(); await page.setContent('<div id="score"></div>');
    await page.addScriptTag({ path: resolve('node_modules/opensheetmusicdisplay/build/opensheetmusicdisplay.min.js') });
    const result = await page.evaluate(async source => {
      const w = window as any;
      const o = new w.opensheetmusicdisplay.OpenSheetMusicDisplay(document.getElementById('score'), { autoResize: false, backend: 'svg' });
      let oldError = '';
      try { await o.load(source); } catch (error) { oldError = (error as Error).message; }
      const parsed = new DOMParser().parseFromString(source, 'application/xml');
      await o.load(parsed); o.render();
      return { oldError, measures: o.Sheet.SourceMeasures.length, parts: o.Sheet.Instruments.length, notes: parsed.getElementsByTagName('note').length, svgs: window.document.querySelectorAll('svg').length, sourceUnchanged: source.startsWith('<score-partwise') };
    }, xml);
    assert.match(result.oldError, /Could not retrieve requested URL|XMLHttpRequest.*Invalid URL/);
    assert.equal(result.measures, 1); assert.equal(result.parts, 1); assert.equal(result.notes, 1); assert.equal(result.svgs, 1); assert.equal(result.sourceUnchanged, true);
  } finally { await browser.close(); }
});
