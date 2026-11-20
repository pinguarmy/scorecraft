import { browserLaunchOptions } from '../browser.ts';
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

export async function renderWithOsmd(xml: string, repair: boolean) {
  const helper = await readFile(resolve('src/components/render-compat.ts'), 'utf8');
  const compiled = ts.transpileModule(helper, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const browser = await chromium.launch(browserLaunchOptions());
  try {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const logs: string[] = [];
    page.on('console', message => logs.push(`${message.type()}: ${message.text()}`));
    page.on('pageerror', error => logs.push(`pageerror: ${error.stack}`));
    await page.setContent('<!doctype html><html><body><div id="score" style="width:1200px"></div></body></html>');
    await page.addScriptTag({ path: resolve('node_modules/opensheetmusicdisplay/build/opensheetmusicdisplay.min.js') });
    await page.addScriptTag({ content: `window.__name=(target)=>target;(()=>{const exports={};${compiled};window.repairOpenOctaveShifts=exports.repairOpenOctaveShifts;})()` });
    const result = await page.evaluate(async ({ source, fix }) => {
      const global = window as any;
      const renderer = new global.opensheetmusicdisplay.OpenSheetMusicDisplay(document.getElementById('score'), { autoResize: false, backend: 'svg', drawTitle: false, drawSubtitle: false, drawComposer: false, drawLyricist: false, drawPartNames: true, drawMetronomeMarks: true, followCursor: false });
      renderer.EngravingRules.CursorIgnoreRepetitions = true;
      let phase = 'load';
      const sourceDocument = new DOMParser().parseFromString(source, 'application/xml');
      const inputNotes = sourceDocument.getElementsByTagName('note').length;
      try {
        await renderer.load(source);
        const fingerprint = () => JSON.stringify(renderer.Sheet.SourceMeasures.map((measure: any) => ({ start: measure.AbsoluteTimestamp.RealValue, duration: measure.Duration.RealValue, entries: measure.VerticalSourceStaffEntryContainers.map((container: any) => ({ time: container.Timestamp.RealValue, staves: container.StaffEntries.map((staff: any) => staff?.VoiceEntries.map((voice: any) => voice.Notes.map((note: any) => ({ duration: note.Length.RealValue, pitch: note.Pitch?.getHalfTone(), rest: note.isRest() })))) })) })));
        const before = fingerprint();
        const compatibility = fix ? global.repairOpenOctaveShifts(renderer.Sheet) : { repairedOctaveShifts: 0, warnings: [] };
        const unchanged = before === fingerprint();
        phase = 'render'; renderer.render();
        renderer.cursor.show(); renderer.cursor.reset();
        const seekBeat = Math.min(17, renderer.Sheet.SourceMeasures.at(-1).AbsoluteTimestamp.RealValue * 4);
        while (!renderer.cursor.iterator.EndReached && renderer.cursor.iterator.CurrentSourceTimestamp.RealValue * 4 < seekBeat) renderer.cursor.next();
        const cursor = { sourceBeat: renderer.cursor.iterator.CurrentSourceTimestamp.RealValue * 4, measure: renderer.cursor.iterator.CurrentMeasureIndex + 1 };
        renderer.render(); renderer.cursor.update();
        return { ok: true, measures: renderer.Sheet.SourceMeasures.length, parts: renderer.Sheet.Instruments.length, svgs: window.document.querySelectorAll('svg').length, inputNotes, unchanged, compatibility, cursor };
      } catch (error) { const e = error as Error; return { ok: false, phase, message: e.message, stack: e.stack, inputNotes }; }
    }, { source: xml, fix: repair });
    return { result, logs };
  } finally { await browser.close(); }
}
