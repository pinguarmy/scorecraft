import { browserLaunchOptions } from '../browser.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

// Authored regular pulse fixture. Each explicit system has three measures.
const bars = Array.from({ length: 96 }, (_, i) => `<measure number="${i + 1}">${i === 0 ? '<attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>' : i % 3 === 0 ? '<print new-system="yes"/>' : ''}<note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note></measure>`).join('');
const xml = `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P"><part-name>Original follow test</part-name></score-part></part-list><part id="P">${bars}</part></score-partwise>`;

async function compiled(file: string) { return ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText; }

test('native SVG pages turn horizontally with actual cursor and vertical follow respects pause/disable', async () => {
  const browser = await chromium.launch(browserLaunchOptions());
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, reducedMotion: 'reduce' });
    await page.setContent('<style>*{box-sizing:border-box}body{margin:0}#frame{width:760px;margin-left:40px;position:relative}#host{width:100%;padding:15px 25px 30px}#host svg{max-width:100%;height:auto}#host>div{max-width:100%}</style><div style="height:150px"></div><div id="frame"><div id="host"></div></div><div style="height:700px"></div>');
    await page.addScriptTag({ path: resolve('node_modules/opensheetmusicdisplay/build/opensheetmusicdisplay.min.js') });
    for (const [name, file] of [['compat', 'src/components/render-compat.ts'], ['follow', 'src/components/score-follow.ts']]) {
      await page.addScriptTag({ content: `window.__name=(f)=>f;(()=>{const exports={};${await compiled(file)};window.${name}=exports;})()` });
    }
    const result = await page.evaluate(async source => {
      const w = window as any; const host = document.getElementById('host')!;
      const osmd = new w.opensheetmusicdisplay.OpenSheetMusicDisplay(host, { backend: 'svg', autoResize: false, pageFormat: 'A4_P', newSystemFromXML: true, followCursor: false });
      osmd.EngravingRules.CursorIgnoreRepetitions = true;
      await osmd.load(new DOMParser().parseFromString(source, 'application/xml')); osmd.render(); osmd.cursor.show(); osmd.cursor.reset();
      const pages = w.follow.arrangeScorePages(host, 'page');
      w.follow.showScorePage(host, 2); const manualLeft = host.scrollLeft;
      const state = w.follow.freshFollowState(); w.compat.syncSourceCursor(osmd, 0);
      w.follow.followScorePosition(osmd, host, state, { mode: 'page', enabled: true, playing: true, beat: 0 });
      let nextPageBeat = 0;
      for (let beat = 4; beat < 384; beat += 4) { w.compat.syncSourceCursor(osmd, beat); if (osmd.cursor.currentPageNumber === 2) { nextPageBeat = beat; break; } }
      const moved = w.follow.followScorePosition(osmd, host, state, { mode: 'page', enabled: true, playing: true, beat: nextPageBeat });
      const image = osmd.cursor.cursorElement; const svg = image.parentElement.querySelector('svg'); const ctm = svg.getScreenCTM();
      const system = osmd.GraphicSheet.MeasureList[osmd.cursor.iterator.CurrentMeasureIndex][0].ParentMusicSystem;
      const top = system.PositionAndShape.AbsolutePosition.y + system.StaffLines[0].PositionAndShape.RelativePosition.y;
      const projectedTop = new DOMPoint(0, top * 10).matrixTransform(ctm).y;
      const horizontal = { count: pages.length, svgs: host.querySelectorAll('svg').length, manualLeft, followedLeft: host.scrollLeft, moved, page: osmd.cursor.currentPageNumber, clientWidth: host.clientWidth, scrollWidth: host.scrollWidth, pageWidth: pages[0].getBoundingClientRect().width, cursorParentPage: image.parentElement.dataset.scorePage, cursorTopError: image.getBoundingClientRect().top - projectedTop };
      w.follow.showScorePage(host, 1); const manuallyReturned = host.scrollLeft;
      w.follow.followScorePosition(osmd, host, state, { mode: 'page', enabled: true, playing: false, beat: nextPageBeat });
      const pausedPageLeft = host.scrollLeft;
      w.compat.syncSourceCursor(osmd, 0); w.follow.followScorePosition(osmd, host, state, { mode: 'page', enabled: true, playing: false, beat: 0 });
      const seekPageLeft = host.scrollLeft;
      osmd.setOptions({ pageFormat: 'Endless' }); osmd.render(); w.follow.arrangeScorePages(host, 'scroll');
      const verticalState = w.follow.freshFollowState(); w.compat.syncSourceCursor(osmd, 0);
      w.follow.followScorePosition(osmd, host, verticalState, { mode: 'scroll', enabled: true, playing: true, beat: 0 });
      w.compat.syncSourceCursor(osmd, 300);
      const verticalMoved = w.follow.followScorePosition(osmd, host, verticalState, { mode: 'scroll', enabled: true, playing: true, beat: 300 }); const autoY = window.scrollY;
      window.scrollTo(0, 0); w.follow.followScorePosition(osmd, host, verticalState, { mode: 'scroll', enabled: true, playing: false, beat: 300 }); const pausedY = window.scrollY;
      w.compat.syncSourceCursor(osmd, 200); w.follow.followScorePosition(osmd, host, verticalState, { mode: 'scroll', enabled: false, playing: false, beat: 200 }); const disabledY = window.scrollY;
      w.follow.followScorePosition(osmd, host, verticalState, { mode: 'scroll', enabled: true, playing: false, beat: 200 }); const enabledY = window.scrollY;
      return { horizontal, manuallyReturned, pausedPageLeft, seekPageLeft, verticalMoved, autoY, pausedY, disabledY, enabledY };
    }, xml);
    assert.ok(result.horizontal.count > 1, JSON.stringify(result));
    assert.equal(result.horizontal.count, result.horizontal.svgs);
    assert.ok(result.horizontal.scrollWidth > result.horizontal.clientWidth);
    assert.ok(result.horizontal.pageWidth <= result.horizontal.clientWidth + 1);
    assert.ok(result.horizontal.manualLeft > 500);
    assert.ok(result.horizontal.followedLeft > 500);
    assert.equal(result.horizontal.cursorParentPage, '2');
    assert.equal(result.horizontal.page, 2);
    assert.ok(Math.abs(result.horizontal.cursorTopError) < 2, JSON.stringify(result.horizontal));
    assert.equal(result.pausedPageLeft, result.manuallyReturned);
    assert.equal(result.seekPageLeft, 0);
    assert.ok(result.verticalMoved && result.autoY > 500, JSON.stringify(result));
    assert.equal(result.pausedY, 0); assert.equal(result.disabledY, 0);
    assert.ok(result.enabledY > 500);
    console.log(JSON.stringify(result));
  } finally { await browser.close(); }
});
