import { useEffect, useRef, useState, useCallback } from 'react';
import type { MouseEvent } from 'react';
import { OpenSheetMusicDisplay, CursorType } from 'opensheetmusicdisplay';
import { repairOpenOctaveShifts, syncSourceCursor, alignCursorToSvg } from './render-compat';
import type { CanonicalMeasure } from './render-compat';
import {
  arrangeScorePages,
  currentScorePage,
  followScorePosition,
  freshFollowState,
  showScorePage,
} from './score-follow';
import type { FollowMode } from './score-follow';

// OSMD 1.9.9 resets cursorsOptions to its green default on every setOptions
// call that omits them, so constructor and page-format updates must share this.
const SCORE_CURSOR_OPTIONS = [{ type: CursorType.ThinLeft, color: '#bd4d35', alpha: 0.85, follow: false }];

export type ScoreViewProps = {
  xml: string;
  position: number;
  measures?: readonly CanonicalMeasure[];
  playing: boolean;
  followMode?: FollowMode;
  followEnabled?: boolean;
  selectedNoteId: string | null;
  onSelectNote: (id: string) => void;
  onSeek: (beat: number) => void;
};

export default function ScoreView({
  xml,
  position,
  measures,
  playing,
  followMode = 'scroll',
  followEnabled = true,
  selectedNoteId: _selectedNoteId,
  onSelectNote: _onSelectNote,
  onSeek,
}: ScoreViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null);
  const [loading, setLoading] = useState(false);
  const [renderRevision, setRenderRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [renderWarnings, setRenderWarnings] = useState<string[]>([]);
  const generationRef = useRef(0);
  const isMountedRef = useRef(true);
  const followState = useRef(freshFollowState());
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(1);
  const latest = useRef({ position, measures, playing, followMode, followEnabled });
  latest.current = { position, measures, playing, followMode, followEnabled };
  const positionCursor = useCallback(() => {
    const osmd = osmdRef.current;
    const container = containerRef.current;
    if (!osmd || !container || !osmd.IsReadyToRender() || !osmd.cursor) return;
    const current = latest.current;
    const cursor = syncSourceCursor(osmd, current.position, current.measures);
    container.dataset.sourceBeat = String(cursor.sourceBeat);
    container.dataset.sourceMeasure = String(cursor.measure);
    container.dataset.engravingBeat = String(cursor.engravingBeat);
    container.dataset.sourcePage = String(currentScorePage(osmd));
    const followed = followScorePosition(osmd, container, followState.current, {
      mode: current.followMode,
      enabled: current.followEnabled,
      playing: current.playing,
      beat: current.position,
    });
    if (current.followMode === 'page' && followed) setPageNumber(currentScorePage(osmd));
  }, []);

  // Keep track of mounted state
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (osmdRef.current) {
        try {
          osmdRef.current.clear();
        } catch {
          // ignore cleanup errors on unmount
        }
        osmdRef.current = null;
      }
    };
  }, []);

  // Main load and render effect
  useEffect(() => {
    if (!xml.trim()) {
      if (osmdRef.current) {
        try {
          osmdRef.current.clear();
        } catch {
          // ignore
        }
      }
      setLoading(false);
      setError(null);
      return;
    }

    const currentGeneration = ++generationRef.current;
    if (containerRef.current) {
      delete containerRef.current.dataset.sourceBeat;
      delete containerRef.current.dataset.sourceMeasure;
      delete containerRef.current.dataset.engravingBeat;
    }
    setLoading(true);
    setError(null);
    setRenderWarnings([]);

    const initAndRender = async () => {
      const container = containerRef.current;
      if (!container) return;

      try {
        let osmd = osmdRef.current;
        if (!osmd) {
          osmd = new OpenSheetMusicDisplay(container, {
            autoResize: false, // We control resizing via ResizeObserver
            backend: 'svg',
            drawTitle: false, // Title and composer are already rendered in App header
            drawSubtitle: false,
            drawComposer: false,
            drawLyricist: false,
            drawPartNames: true,
            drawMetronomeMarks: true,
            followCursor: false,
            cursorsOptions: SCORE_CURSOR_OPTIONS,
          });
          osmdRef.current = osmd;
        }

        // Playback owns repeat expansion. The notation cursor traverses source order only.
        osmd.setOptions({
          pageFormat: followMode === 'page' ? 'A4_P' : 'Endless',
          cursorsOptions: SCORE_CURSOR_OPTIONS,
        });
        followState.current = freshFollowState();
        osmd.EngravingRules.CursorIgnoreRepetitions = true;
        // OSMD treats short strings without an XML declaration as URLs.
        // The app already supplies XML, so use its explicit Document API.
        const document = new DOMParser().parseFromString(xml, 'application/xml');
        if (document.getElementsByTagName('parsererror').length) throw new Error('MusicXML 不能解析为有效 XML。');
        await osmd.load(document);

        // Check if obsolete
        if (generationRef.current !== currentGeneration || !isMountedRef.current) {
          return;
        }

        const compatibility = repairOpenOctaveShifts(osmd.Sheet);
        setRenderWarnings(compatibility.warnings);
        osmd.render();
        const pages = arrangeScorePages(container, followMode);
        setPageCount(pages.length || 1);
        setPageNumber(1);

        if (osmd.cursor) {
          osmd.cursor.show();
          osmd.cursor.reset();
          alignCursorToSvg(osmd);
        }

        if (isMountedRef.current && generationRef.current === currentGeneration) {
          setLoading(false);
          setRenderRevision((revision) => revision + 1);
          setError(null);
        }
      } catch (err) {
        if (isMountedRef.current && generationRef.current === currentGeneration) {
          setLoading(false);
          const msg = err instanceof Error ? err.message : String(err);
          setError(`五线谱排版失败：${msg}`);
        }
      }
    };

    void initAndRender();
  }, [xml, followMode]);

  // Position / cursor synchronization without reloading
  useEffect(() => {
    const osmd = osmdRef.current;
    if (loading || !osmd || !osmd.IsReadyToRender() || !osmd.cursor) return;

    const frame = requestAnimationFrame(() => {
      try {
        positionCursor();
      } catch {
        if (containerRef.current) {
          delete containerRef.current.dataset.sourceBeat;
          delete containerRef.current.dataset.sourceMeasure;
          delete containerRef.current.dataset.engravingBeat;
        }
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [position, measures, playing, followEnabled, followMode, loading, renderRevision, positionCursor]);

  // ResizeObserver for clean responsive rerenders
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let resizeTimer: number | null = null;
    let lastWidth = container.clientWidth;
    const observer = new ResizeObserver(() => {
      const width = container.clientWidth;
      if (Math.abs(width - lastWidth) < 1) return;
      lastWidth = width;
      if (resizeTimer) window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        const osmd = osmdRef.current;
        if (osmd && osmd.IsReadyToRender() && isMountedRef.current) {
          try {
            osmd.render();
            const pages = arrangeScorePages(container, latest.current.followMode);
            setPageCount(pages.length || 1);
            if (osmd.cursor) positionCursor();
          } catch {
            // Ignore transient resize errors
          }
        }
      }, 250);
    });

    observer.observe(container);

    return () => {
      if (resizeTimer) window.clearTimeout(resizeTimer);
      observer.disconnect();
    };
  }, []);

  // Handle click on score: map click to measure / note beat for seeking
  const handleClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      const osmd = osmdRef.current;
      if (!osmd || !osmd.GraphicSheet || !osmd.IsReadyToRender()) return;

      const container = containerRef.current;
      if (!container) return;

      const svg = (e.target as Element).closest('svg');
      const matrix = svg?.getScreenCTM();
      if (!svg || !matrix) return;
      const point = new DOMPoint(e.clientX, e.clientY).matrixTransform(matrix.inverse());
      const clickX = point.x;
      const clickY = point.y;
      const clickedPage = svg.closest<HTMLElement>('[data-score-page]')?.dataset.scorePage;

      // Search through graphical measures to locate which measure was clicked
      try {
        const measureList = osmd.GraphicSheet.MeasureList;
        if (!measureList || !measureList.length) return;

        // In OSMD, measure coordinates are scaled by zoom factor (usually 1.0 or 10.0 in pixels)
        // Check measure bounding boxes
        for (let m = 0; m < measureList.length; m++) {
          const staves = measureList[m];
          if (!staves || !staves.length) continue;

          for (const gm of staves) {
            if (!gm || !gm.PositionAndShape) continue;
            const graphicalPage = gm.ParentMusicSystem?.Parent;
            if (clickedPage && graphicalPage && graphicalPage.PageNumber !== Number(clickedPage)) continue;
            const bbox = gm.PositionAndShape;
            // AbsolutePosition in OSMD units (1 unit = 10px approx at zoom 1)
            const zoom = osmd.zoom || 1;
            const left = bbox.AbsolutePosition.x * 10 * zoom;
            const top = bbox.AbsolutePosition.y * 10 * zoom;
            const width = bbox.Size.width * 10 * zoom;
            const height = bbox.Size.height * 10 * zoom;

            if (clickX >= left && clickX <= left + width && clickY >= top && clickY <= top + height) {
              const sourceMeasure = gm.parentSourceMeasure;
              if (sourceMeasure) {
                // AbsoluteTimestamp is Fraction of whole notes; convert to quarter-note beats
                const beat = measures?.[m]?.startBeat ?? sourceMeasure.AbsoluteTimestamp.RealValue * 4;
                onSeek(beat);
                return;
              }
            }
          }
        }
      } catch {
        // Fallback: click did not match a known bounding box
      }
    },
    [onSeek, measures],
  );

  return (
    <div className="score-view" style={{ background: '#fffdf8' }}>
      {loading && (
        <div className="score-render-message" role="status">
          正在排版五线谱…
        </div>
      )}
      {renderWarnings.length > 0 && (
        <div className="notice" role="status" aria-label="乐谱排版兼容提示">
          {renderWarnings.map((warning) => (
            <p key={warning}>{warning}</p>
          ))}
        </div>
      )}
      {error && (
        <div className="score-render-error" role="alert">
          {error}
        </div>
      )}
      {followMode === 'page' && !error && (
        <nav
          aria-label="乐谱翻页"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 18,
            padding: '10px 0',
            color: '#6b736d',
          }}
        >
          <button
            type="button"
            aria-label="上一页乐谱"
            disabled={pageNumber <= 1}
            onClick={() => {
              const page = Math.max(1, pageNumber - 1);
              if (containerRef.current) showScorePage(containerRef.current, page);
              setPageNumber(page);
            }}
          >
            ← 上一页
          </button>
          <span aria-live="polite">
            第 {pageNumber} / {pageCount} 页
          </span>
          <button
            type="button"
            aria-label="下一页乐谱"
            disabled={pageNumber >= pageCount}
            onClick={() => {
              const page = Math.min(pageCount, pageNumber + 1);
              if (containerRef.current) showScorePage(containerRef.current, page);
              setPageNumber(page);
            }}
          >
            下一页 →
          </button>
        </nav>
      )}
      <div
        ref={containerRef}
        className="score-render-host"
        aria-label={followMode === 'page' ? '横向翻页乐谱' : '连续滚动乐谱'}
        onScroll={(e) => {
          if (followMode !== 'page') return;
          const container = e.currentTarget;
          const pages = Array.from(container.children).filter(
            (element) => element instanceof HTMLElement && element.dataset.scorePage,
          ) as HTMLElement[];
          const left = container.getBoundingClientRect().left;
          const nearest = pages.reduce<HTMLElement | null>(
            (best, page) =>
              !best ||
              Math.abs(page.getBoundingClientRect().left - left) < Math.abs(best.getBoundingClientRect().left - left)
                ? page
                : best,
            null,
          );
          if (nearest) setPageNumber(Number(nearest.dataset.scorePage));
        }}
        onClick={handleClick}
        style={{
          display: error ? 'none' : followMode === 'page' ? 'flex' : 'block',
          cursor: 'pointer',
          minHeight: followMode === 'page' ? 0 : '320px',
          maxWidth: '100%',
        }}
      />
    </div>
  );
}
