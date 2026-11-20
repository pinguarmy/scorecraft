// 谱间 ScoreCraft 的组合根。
//
// 状态按职责分到 src/app/ 的 hooks 中，页面区域在 src/components/。这里保留的是
// 跨模块的编排：当前打开的乐谱与文档身份、切换乐谱（activate）和保存当前会话（saveCurrent）。
//
// 注意 hooks 的调用顺序：它们的 effect 按调用顺序执行，这里与拆分前的 effect 顺序一致。
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { transposeXml } from './music';
import type { Score } from './music';
import { sanitizeSession } from './practice/session';
import type { PracticeSession, RecentDocument } from './practice/session';
import { buildLibraryItems } from './app/library-items';
import type { LibraryItem } from './app/library-items';
import { configurePlayer } from './app/player-config';
import { measureIndexAt, practiceSummary, scoreBounds, tempoPresets } from './app/score-helpers';
import type { ActiveDocument, Notice, Original } from './app/types';
import { useDocumentLibrary } from './app/useDocumentLibrary';
import { useHealth } from './app/useHealth';
import { useInstrumentArrangement } from './app/useInstrumentArrangement';
import { useKeyboardShortcuts } from './app/useKeyboardShortcuts';
import { useMeasureJump } from './app/useMeasureJump';
import { isCompactLayout, TOOLS_PANEL_ID, useMobileTools } from './app/useMobileTools';
import { usePracticePlayer } from './app/usePracticePlayer';
import { usePracticeSettings } from './app/usePracticeSettings';
import { useScanJobs } from './app/useScanJobs';
import { useScoreCorrections } from './app/useScoreCorrections';
import { useScoreExport } from './app/useScoreExport';
import { useScoreOpening } from './app/useScoreOpening';
import { useShortcutsDialog } from './app/useShortcutsDialog';
import { CurrentPracticePanel } from './components/CurrentPracticePanel';
import { ExportPanel } from './components/ExportPanel';
import { Icon } from './components/Icon';
import { LibrarySidebar } from './components/LibrarySidebar';
import { Masthead } from './components/Masthead';
import { ReviewPanel } from './components/ReviewPanel';
import { ScoreDesk } from './components/ScoreDesk';
import { ShortcutsDialog } from './components/ShortcutsDialog';
import { SoundSettings } from './components/SoundSettings';
import { Transport } from './components/Transport';

export default function App() {
  // —— 当前乐谱与页面状态 ——
  const [score, setScore] = useState<Score | null>(null);
  const [source, setSource] = useState('尚未导入');
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [libraryExpanded, setLibraryExpanded] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState('');
  const [dragging, setDragging] = useState(false);
  const [renderXml, setRenderXml] = useState('');
  const [original, setOriginal] = useState<Original | null>(null);
  const [recognitionWarnings, setRecognitionWarnings] = useState<string[]>([]);
  const reviewRef = useRef<HTMLDetailsElement>(null);
  const originalRef = useRef<HTMLDetailsElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const importButton = useRef<HTMLButtonElement>(null);

  // —— 跨模块共享的同步副本（异步流程与播放器回调读取它们，避免过期闭包） ——
  /** 当前打开请求与流程编号，见 useScoreOpening。 */
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const scoreRef = useRef<Score | null>(null);
  const activeRef = useRef<ActiveDocument | null>(null);
  const sessionRef = useRef<PracticeSession | null>(null);
  /** activate 切换乐谱期间为 true：此时不保存，播放器回调也不写会话。 */
  const switchingRef = useRef(false);
  /** 总是指向最新一次渲染的 saveCurrent，供 effect 与播放器回调调用。 */
  const saveRef = useRef<() => void>(() => {});

  const library = useDocumentLibrary(setNotice);
  const scans = useScanJobs();

  useEffect(() => {
    void library.ensureDocuments();
    void scans.refreshScans();
  }, [library.ensureDocuments]);
  useEffect(() => {
    // 窄屏布局下谱库在乐谱上方，打开乐谱后滚到谱架。断点与布局使用同一个媒体查询。
    if (activeDocumentId && isCompactLayout()) {
      document.getElementById('score-desk')?.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  }, [activeDocumentId]);

  const playback = usePracticePlayer({
    switchingRef,
    sessionRef,
    saveRef,
    librarySaver: library.librarySaver,
    request,
    scoreRef,
    setNotice,
  });
  const tools = useMobileTools(reviewRef);
  const { compactLayout, mobileToolsOpen, setMobileToolsOpen, sheetOpen, openTools } = tools;
  const { health, healthError, refreshHealth } = useHealth();
  useEffect(() => {
    return () => {
      if (original?.url.startsWith('blob:')) URL.revokeObjectURL(original.url);
    };
  }, [original]);
  const shortcuts = useShortcutsDialog({
    sheetOpen,
    setMobileToolsOpen,
    practiceTriggerRef: tools.practiceTriggerRef,
  });
  const practice = usePracticeSettings({ score, player: playback.player, sessionRef, saveRef });
  const { tempo, transpose, loop, loopStart, loopEnd, muted, solo } = practice;
  useEffect(() => {
    if (!score) {
      setRenderXml('');
      return;
    }
    try {
      setRenderXml(transpose === 0 ? score.xml : transposeXml(score.xml, transpose));
    } catch (e) {
      setNotice({ kind: 'error', text: `移调未应用：${e instanceof Error ? e.message : String(e)}` });
      setRenderXml(score.xml);
    }
  }, [score, transpose]);

  const currentMeasureIndex = measureIndexAt(score, playback.position);
  const jump = useMeasureJump({ score, currentMeasureIndex, seek: playback.seek });
  useKeyboardShortcuts({
    togglePlay: playback.togglePlay,
    score,
    currentMeasureIndex,
    seek: playback.seek,
    showKeys: shortcuts.showKeys,
    compactLayout,
    mobileToolsOpen,
    setMetronome: practice.setMetronome,
    setLoop: practice.setLoop,
    openShortcuts: shortcuts.openFromKeyboard,
  });

  /** 把当前乐谱与练习会话写入谱库（和浏览器最近历史）。切换乐谱期间不写。 */
  function saveCurrent() {
    const active = activeRef.current;
    const current = scoreRef.current;
    const session = sessionRef.current;
    if (!active || !current || !session || switchingRef.current) return;
    const item: RecentDocument = {
      id: active.id,
      source: active.source,
      ...(active.jobId ? { jobId: active.jobId } : {}),
      title: current.title,
      composer: current.composer,
      xml: current.xml,
      opened: active.opened || Date.now(),
      session: { ...session, muted: [...session.muted], partInstruments: { ...session.partInstruments } },
    };
    library.saveDocument(item);
  }
  saveRef.current = saveCurrent;

  /**
   * 让 next 成为当前乐谱。
   * - preserve=false：打开另一份谱。恢复它保存的会话（restoredSession 或最近历史），重置校对与导出表单。
   * - preserve=true：同一文档的新版本（校正、改名、撤销）。保留当前会话、打开时间和表单状态。
   * 切换期间 switchingRef 为 true，播放器停止回调不会触发保存；结束后保存一次新状态。
   */
  function activate(
    next: Score,
    from: string,
    id: string,
    jobId?: string,
    preserve = false,
    restoredSession?: unknown,
    openedAt?: number,
  ) {
    if (activeRef.current && activeRef.current.id !== id) saveCurrent();
    const prior = preserve
      ? sessionRef.current
      : (restoredSession ?? library.recentRef.current.find(item => item.id === id)?.session);
    const settings = sanitizeSession(prior, scoreBounds(next));
    if (!preserve) library.historySuppressed.current = false;
    switchingRef.current = true;
    try {
      playback.player.current?.stop();
      scoreRef.current = next;
      const opened = openedAt ?? (preserve && activeRef.current?.opened ? activeRef.current.opened : Date.now());
      activeRef.current = { id, source: from, opened, ...(jobId ? { jobId } : {}) };
      sessionRef.current = settings;
      configurePlayer(playback.player.current, next, settings);
      setScore(next);
      setSource(from);
      setActiveDocumentId(id);
      playback.setPosition(settings.position);
      playback.setPlaying(false);
      practice.applySession(settings, next);
      jump.resetForScore(next, settings.position);
      corrections.resetForScore(next, preserve);
      playback.resetCountIn();
      if (!preserve) {
        instruments.reset();
        exporter.reset();
      }
    } finally {
      switchingRef.current = false;
    }
    saveCurrent();
    if (!preserve) {
      setLibraryExpanded(false);
      setMobileToolsOpen(false);
      setRecognitionWarnings([]);
    }
  }

  const corrections = useScoreCorrections({
    score,
    source,
    scoreRef,
    activeRef,
    activate,
    setNotice,
    currentMeasureIndex,
  });
  const instruments = useInstrumentArrangement({
    score,
    partInstruments: practice.partInstruments,
    setPartInstruments: practice.setPartInstruments,
    player: playback.player,
    sessionRef,
    saveCurrent,
    setNotice,
  });
  const exporter = useScoreExport(
    score,
    {
      tempo,
      transpose,
      followRepeats: practice.followRepeats,
      partInstruments: practice.partInstruments,
      solo,
      muted,
      loopStart,
      loopEnd,
    },
    setNotice,
  );
  const opening = useScoreOpening({
    request,
    generation,
    activeRef,
    reviewRef,
    library,
    scans,
    health,
    saveCurrent,
    activate,
    openTools,
    setBusy,
    setNotice,
    setOriginal,
    setRecognitionWarnings,
  });

  function showOriginal() {
    setMobileToolsOpen(false);
    if (originalRef.current) originalRef.current.open = true;
    requestAnimationFrame(() => {
      originalRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
      originalRef.current?.querySelector('summary')?.focus({ preventScroll: true });
    });
  }
  function showLibrary() {
    setMobileToolsOpen(false);
    setLibraryExpanded(true);
    requestAnimationFrame(() => {
      importButton.current?.scrollIntoView({ block: 'center', behavior: 'instant' });
      importButton.current?.focus({ preventScroll: true });
    });
  }
  function retryLibrarySave(force = false) {
    const active = activeRef.current;
    if (!active) return;
    library.retrySave(active.id, force);
  }
  function openLibraryItem(item: LibraryItem) {
    if (item.scan) void opening.openScan(item.scan);
    else if (item.state === 'cached' && item.recent) void opening.openRecent(item.recent);
    else void opening.openSavedDocument(item.id);
  }
  function practiceCurrentSegment() {
    if (!score) return;
    const start = currentMeasureIndex + 1;
    practice.setLoopStart(start);
    practice.setLoopEnd(Math.min(score.measures.length, start + 3));
    practice.setLoop(true);
  }
  function skipMeasure(direction: number) {
    if (!score) return;
    const index = Math.max(0, Math.min(score.measures.length - 1, currentMeasureIndex + direction));
    playback.seek(score.measures[index].startBeat);
  }
  function chooseFile() {
    fileInput.current?.click();
  }
  function drop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) void opening.importFile(file);
  }
  function changeFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) void opening.importFile(file);
    e.target.value = '';
  }

  // —— 派生值 ——
  const currentSaveState = activeDocumentId ? library.saveStates[activeDocumentId] : undefined;
  const reviewWarnings = useMemo(
    () => [...new Set([...(score?.warnings ?? []), ...recognitionWarnings])],
    [score, recognitionWarnings],
  );
  const libraryDocuments = useMemo(
    () =>
      buildLibraryItems(
        library.recent,
        library.savedDocuments,
        library.saveStates,
        library.librarySnapshots.current,
        scans.scanJobs,
      ),
    [library.recent, library.savedDocuments, library.saveStates, scans.scanJobs],
  );
  const summary = practiceSummary({ score, solo, muted, loop, loopStart, loopEnd, transpose });
  const { baseTempo, slowTempo, fullTempo } = tempoPresets(score);
  const quickLoopLength = score ? Math.min(4, score.measures.length - currentMeasureIndex) : 0;

  return (
    <div
      className={`app ${dragging ? 'is-dragging' : ''} ${mobileToolsOpen ? 'mobile-tools-open' : ''}`}
      onDragOver={e => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={drop}
    >
      <a className="skip-link" href="#score-desk">
        跳到乐谱
      </a>
      <input
        ref={fileInput}
        type="file"
        className="sr-only"
        accept=".xml,.musicxml,.mxl,.pdf,.png,.jpg,.jpeg"
        onChange={changeFile}
        aria-label="导入乐谱文件"
      />
      <Masthead inert={sheetOpen} onToggleShortcuts={shortcuts.toggleKeys} />
      <div className="workspace">
        <LibrarySidebar
          hasScore={!!score}
          expanded={libraryExpanded}
          onToggleExpanded={() => setLibraryExpanded(value => !value)}
          inert={sheetOpen}
          importButtonRef={importButton}
          onChooseFile={chooseFile}
          documents={libraryDocuments}
          activeDocumentId={activeDocumentId}
          libraryError={library.libraryError}
          sessionReady={library.sessionReady}
          onRefreshLibrary={() => {
            void library.refreshLibrary();
            void scans.refreshScans();
          }}
          onOpenDocument={openLibraryItem}
          onLoadDemo={repeatStudy => void opening.loadDemo(repeatStudy)}
          hasRecent={library.recent.length > 0}
          onClearHistory={library.clearHistory}
          scans={scans}
          onOpenScan={job => void opening.openScan(job)}
          onRetryWithoutCover={job => void opening.retryWithoutCover(job)}
          onDeleteScan={job =>
            void scans.deleteScan(job, jobId => {
              setOriginal(current => (current?.jobId === jobId ? null : current));
              setNotice({
                kind: 'info',
                text: '已删除扫描结果和原稿。本机谱库与浏览器中的校正版没有删除，仍可练习和导出。',
              });
            })
          }
          health={health}
          healthError={healthError}
          onRefreshHealth={() => void refreshHealth()}
        />
        <ScoreDesk
          inert={sheetOpen}
          score={score}
          source={source}
          renderXml={renderXml}
          position={playback.position}
          playing={playback.playing}
          tempo={tempo}
          transpose={transpose}
          currentMeasureIndex={currentMeasureIndex}
          followMode={practice.followMode}
          onFollowModeChange={practice.setFollowMode}
          followEnabled={practice.followEnabled}
          onToggleFollow={() => practice.setFollowEnabled(value => !value)}
          metadata={corrections.metadata}
          saveState={currentSaveState}
          onRetrySave={retryLibrarySave}
          scanRetention={scans.scanRetention}
          onShowLibrary={showLibrary}
          notice={notice}
          onDismissNotice={() => setNotice(null)}
          busy={busy}
          onCancelWaiting={opening.cancelWaiting}
          original={original}
          originalRef={originalRef}
          onShowOriginal={showOriginal}
          onOpenReview={() => openTools('review')}
          reviewWarningCount={reviewWarnings.length}
          selectedNoteId={corrections.notes.selectedNoteId}
          onSelectNote={corrections.notes.selectNote}
          onSeek={playback.seek}
          onChooseFile={chooseFile}
          onLoadDemo={() => void opening.loadDemo()}
        />
        <aside className="inspector" aria-label="练习设置和音符校正">
          <Transport
            inert={sheetOpen}
            score={score}
            playback={playback}
            currentMeasureIndex={currentMeasureIndex}
            tempo={tempo}
            onTempoChange={practice.setTempo}
            practiceSummary={summary.text}
            loop={loop}
            onEndLoop={() => practice.setLoop(false)}
            allPartsMuted={summary.allPartsMuted}
            onHearAllParts={practice.hearAllParts}
            practiceTriggerRef={tools.practiceTriggerRef}
            onOpenTools={openTools}
            onSkipMeasure={skipMeasure}
          />
          <div
            ref={tools.toolsRef}
            id={TOOLS_PANEL_ID}
            className="inspector-settings"
            role={sheetOpen ? 'dialog' : undefined}
            aria-modal={sheetOpen ? true : undefined}
            aria-label={sheetOpen ? '练习与工具' : undefined}
            inert={compactLayout && !mobileToolsOpen ? true : undefined}
            tabIndex={-1}
          >
            <div className="mobile-tools-header">
              <h2>练习与工具</h2>
              <button className="text-button" aria-label="关闭练习工具" onClick={() => setMobileToolsOpen(false)}>
                回到乐谱 ×
              </button>
            </div>
            <CurrentPracticePanel
              score={score}
              practice={practice}
              jump={jump}
              baseTempo={baseTempo}
              slowTempo={slowTempo}
              fullTempo={fullTempo}
              quickLoopLength={quickLoopLength}
              onPracticeCurrentSegment={practiceCurrentSegment}
            />
            <SoundSettings
              score={score}
              partInstruments={practice.partInstruments}
              instruments={instruments}
              audioReady={playback.audioState === 'ready'}
              onToggleShortcuts={shortcuts.toggleKeys}
            />
            <ReviewPanel
              reviewRef={reviewRef}
              score={score}
              original={original}
              onShowOriginal={showOriginal}
              reviewWarnings={reviewWarnings}
              currentMeasureIndex={currentMeasureIndex}
              corrections={corrections}
            />
            <ExportPanel score={score} exporter={exporter} loopStart={loopStart} loopEnd={loopEnd} />
          </div>
        </aside>
      </div>
      {sheetOpen && (
        <div className="mobile-tools-backdrop" onClick={() => setMobileToolsOpen(false)} aria-hidden="true" />
      )}
      {dragging && (
        <div className="drop-overlay">
          <Icon name="upload" size={42} />
          <h2>放下这一页谱</h2>
          <p>MusicXML / MXL / PDF / PNG / JPEG</p>
        </div>
      )}
      {shortcuts.showKeys && <ShortcutsDialog dialogRef={shortcuts.dialogRef} onClose={shortcuts.closeKeys} />}
    </div>
  );
}
