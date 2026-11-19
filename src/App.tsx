import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, DragEvent, ReactNode } from 'react';
import { readScore, exportMidi, transposeXml, updateNoteXml, scoreToWav, ScorePlayer, inspectOpenOctaveShifts, removeOpenOctaveShiftsXml, updateTimeSignatureXml } from './music';
import { displayPartName, updatePartNameXml } from './music/part-labels';
import type { Score, ScoreNote } from './music';
import { DEFAULT_INSTRUMENT, INSTRUMENTS, getInstrumentWarnings, isInstrumentId } from './music/instruments';
import type { InstrumentId } from './music/instruments';
import { ARRANGEMENTS, allPartsInstrumentMap, getArrangementMap } from './music/arrangements';
import type { ArrangementPreset } from './music/arrangements';
import { documentId, loadDocuments, sanitizeSession, saveDocuments, upsertDocument } from './practice/session';
import type { PracticeSession, RecentDocument } from './practice/session';
import { createLibrarySaver, getOutboxEntry, getSavedDocument, listOutboxEntries, listSavedDocuments, migrateBrowserDocuments } from './practice/library';
import type { LibrarySaveState, RemoteSavedDocument, SavedDocumentMetadata } from './practice/library';
const ScoreView = lazy(() => import('./components/ScoreView'));

type Health = { ok: boolean; engine: { available: boolean; name: string; version?: string; detail?: string }; limits: { maxUploadBytes: number } };
type ScanResult = { id: string; status: string; message?: string; warnings?: string[]; resultUrl?: string; skippedPages?: number[] };
type ScanJob = { id: string; status: 'queued' | 'running' | 'done' | 'error'; createdAt: number | string; originalName?: string; message?: string; originalUrl?: string; resultUrl?: string };
const browserStorage = { getItem(key: string) { try { return localStorage.getItem(key); } catch { return null; } }, setItem(key: string, value: string) { localStorage.setItem(key, value); } };
const validJobId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
type Notice = { kind: 'error' | 'info'; text: string } | null;
type Original = { url: string; name: string; pdf: boolean; jobId?: string };
const pitchNames = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
const pitchName = (midi: number) => `${pitchNames[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
function instrumentMap(value: Record<string, string> | undefined, score: Score): Record<string, InstrumentId> {
  const result: Record<string, InstrumentId> = {};
  for (const part of score.parts) { const id = value?.[part.id]; if (isInstrumentId(id) && (id !== 'drums' || part.notes.some(note => note.percussion !== undefined))) result[part.id] = id; }
  return result;
}
function scoreBounds(score: Score) { return { tempo: score.tempo, totalBeats: score.totalBeats, measureCount: score.measures.length, partIds: score.parts.map(part => part.id) }; }
function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const paths: Record<string, ReactNode> = {
    play: <path d="m9 5 11 7-11 7Z" fill="currentColor" stroke="none" />,
    pause: <><path d="M8 5v14M16 5v14" strokeWidth="4" /></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="1" fill="currentColor" stroke="none" />,
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" /></>,
    download: <><path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4" /></>,
    file: <><path d="M6 3h8l4 4v14H6Z M14 3v5h4M9 12h6M9 16h6" /></>,
    back: <path d="m14 6-6 6 6 6M5 5v14" />,
    forward: <path d="m10 6 6 6-6 6M19 5v14" />,
    loop: <><path d="M5 7h12l3 3m0-3v3h-3M19 17H7l-3-3m0 3v-3h3M4 11V9a2 2 0 0 1 2-2m14 6v2a2 2 0 0 1-2 2" /></>,
    sound: <><path d="m11 4-6 5H2v6h3l6 5ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" /></>,
    pen: <><path d="m4 16 11-11 4 4L8 20H4ZM13 7l4 4" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    print: <><path d="M7 8V3h10v5M7 17H3V8h18v9h-4M7 14h10v7H7Z" /></>,
    note: <><path d="M10 17V5l9-2v12M10 9l9-2" /><ellipse cx="7" cy="18" rx="3" ry="2" /><ellipse cx="16" cy="16" rx="3" ry="2" /></>,
    undo: <><path d="M8 7H3V2m0 5a9 9 0 1 1-1 9" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 2" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.note}</svg>;
}
function download(data: string | Uint8Array, mime: string, name: string) {
  const content = typeof data === 'string' ? data : new Uint8Array(data).buffer;
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function responseError(response: Response) { try { const body = await response.json(); return typeof body.error === 'string' ? body.error : typeof body.message === 'string' ? body.message : `请求失败，HTTP ${response.status}`; } catch { return `请求失败，HTTP ${response.status}`; } }

export default function App() {
  const [score, setScore] = useState<Score | null>(null);
  const [source, setSource] = useState('尚未导入');
  const [recent, setRecent] = useState<RecentDocument[]>([]);
  const [sessionReady, setSessionReady] = useState(false);
  const [savedDocuments, setSavedDocuments] = useState<SavedDocumentMetadata[]>([]);
  const [libraryError, setLibraryError] = useState('');
  const [saveStates, setSaveStates] = useState<Record<string, LibrarySaveState>>({});
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [followRepeats, setFollowRepeats] = useState(true);
  const [followMode, setFollowMode] = useState<'scroll' | 'page'>('scroll');
  const [followEnabled, setFollowEnabled] = useState(true);
  const [scanOpen, setScanOpen] = useState(false);
  const [libraryExpanded, setLibraryExpanded] = useState(false);
  const [mobileToolsOpen, setMobileToolsOpen] = useState(false);
  const [compactLayout, setCompactLayout] = useState(() => window.matchMedia('(max-width: 999px)').matches);
  const toolsRef = useRef<HTMLDivElement>(null);
  const reviewRef = useRef<HTMLDetailsElement>(null);
  const originalRef = useRef<HTMLDetailsElement>(null);
  const practiceTriggerRef = useRef<HTMLButtonElement>(null);
  const toolsTriggerRef = useRef<HTMLElement | null>(null);
  const [scanJobs, setScanJobs] = useState<ScanJob[]>([]);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState('');
  const [scanRetention, setScanRetention] = useState(7);
  const [deleteJobId, setDeleteJobId] = useState<string | null>(null);
  const [deletingJob, setDeletingJob] = useState<string | null>(null);
  const [retryingJob, setRetryingJob] = useState<string | null>(null);
  const [editingMetadata, setEditingMetadata] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [composerDraft, setComposerDraft] = useState('');
  const [renamingPartId, setRenamingPartId] = useState<string | null>(null);
  const [partNameDraft, setPartNameDraft] = useState('');
  const [confirmOctaveRemoval, setConfirmOctaveRemoval] = useState(false);
  const [meterMeasure, setMeterMeasure] = useState(1);
  const [meterBeats, setMeterBeats] = useState(4);
  const [meterBeatType, setMeterBeatType] = useState(4);
  const [confirmMeter, setConfirmMeter] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [busy, setBusy] = useState('');
  const [dragging, setDragging] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [audioState, setAudioState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [audioMessage, setAudioMessage] = useState('');
  const [position, setPosition] = useState(0);
  const [jumpMeasure, setJumpMeasure] = useState('1');
  const [jumpError, setJumpError] = useState('');
  const jumpFocused = useRef(false);
  const [tempo, setTempo] = useState(88);
  const [transpose, setTranspose] = useState(0);
  const [metronome, setMetronome] = useState(false);
  const [countIn, setCountIn] = useState(false);
  const [countInRemaining, setCountInRemaining] = useState<number | null>(null);
  const [countInCancelled, setCountInCancelled] = useState(false);
  const [exportScope, setExportScope] = useState<'full' | 'excerpt'>('full');
  const [muted, setMuted] = useState<string[]>([]);
  const [partInstruments, setPartInstruments] = useState<Record<string, InstrumentId>>({});
  const [arrangementPreset, setArrangementPreset] = useState('none');
  const [showInstrumentDetails, setShowInstrumentDetails] = useState(false);
  const [solo, setSolo] = useState<string | null>(null);
  const [loop, setLoop] = useState(false);
  const [loopStart, setLoopStart] = useState(1);
  const [loopEnd, setLoopEnd] = useState(1);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [editPitch, setEditPitch] = useState(60);
  const [undo, setUndo] = useState<string[]>([]);
  const [exporting, setExporting] = useState(false);
  const [showKeys, setShowKeys] = useState(false);
  const [renderXml, setRenderXml] = useState('');
  const [original, setOriginal] = useState<Original | null>(null);
  const [recognitionWarnings, setRecognitionWarnings] = useState<string[]>([]);
  const dialogRef = useRef<HTMLElement>(null);
  const shortcutTrigger = useRef<HTMLElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const importButton = useRef<HTMLButtonElement>(null);
  const player = useRef<ScorePlayer | null>(null);
  const request = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const scoreRef = useRef<Score | null>(null);
  const recentRef = useRef<RecentDocument[]>([]);
  const activeRef = useRef<{ id: string; source: string; jobId?: string; opened?: number } | null>(null);
  const sessionRef = useRef<PracticeSession | null>(null);
  const hydrationRef = useRef<Promise<RecentDocument[]> | null>(null);
  const switchingRef = useRef(false);
  const playingRef = useRef(false);
  const lastPositionSave = useRef(0);
  const saveRef = useRef<() => void>(() => {});
  const historySuppressed = useRef(false);
  const deletedJobs = useRef(new Set<string>());
  const countingRef = useRef(false);
  const countEndedRef = useRef(false);
  const librarySnapshots = useRef(new Map<string, RecentDocument>());
  const libraryStates = useRef(new Map<string, LibrarySaveState>());
  const librarySaver = useRef<ReturnType<typeof createLibrarySaver> | null>(null);
  if (!librarySaver.current) librarySaver.current = createLibrarySaver(state => {
    libraryStates.current.set(state.id, state); setSaveStates(previous => ({ ...previous, [state.id]: state }));
    const snapshot = librarySnapshots.current.get(state.id);
    if (state.status === 'saved' && state.receipt && snapshot) {
      const metadata: SavedDocumentMetadata = { id: snapshot.id, title: snapshot.title, composer: snapshot.composer, source: snapshot.source, jobId: snapshot.jobId, opened: snapshot.opened, updatedAt: state.receipt.updatedAt, xmlBytes: state.receipt.xmlBytes };
      setSavedDocuments(previous => [metadata, ...previous.filter(item => item.id !== state.id)].sort((a, b) => b.updatedAt - a.updatedAt));
    }
  });

  const ensureDocuments = useCallback(() => {
    if (!hydrationRef.current) hydrationRef.current = (async () => {
      let docs: RecentDocument[] = [];
      try { docs = await loadDocuments(browserStorage); } catch { docs = []; }
      recentRef.current = docs; setRecent(docs);
      try {
        const outboxEntries = await listOutboxEntries();
        for (const outboxEntry of outboxEntries) {
          librarySnapshots.current.set(outboxEntry.id, outboxEntry.document);
          if (outboxEntry.knownUpdatedAt !== undefined) {
            librarySaver.current?.setKnownVersion(outboxEntry.id, outboxEntry.knownUpdatedAt);
          }
          libraryStates.current.set(outboxEntry.id, { id: outboxEntry.id, status: 'error', error: '上次未保存的更改已保留。' });
          setSaveStates(previous => ({ ...previous, [outboxEntry.id]: { id: outboxEntry.id, status: 'error', error: '上次未保存的更改已保留。' } }));
        }
        const existing = await listSavedDocuments(); setSavedDocuments(existing);
        await migrateBrowserDocuments(docs, new Set(existing.map(item => item.id)));
        if (docs.some(doc => !existing.some(item => item.id === doc.id))) setSavedDocuments(await listSavedDocuments());
        setLibraryError('');
      } catch (error) { setLibraryError(`本机谱库暂不可用，浏览器历史仍保留。${error instanceof Error ? error.message : ''}`); }
      setSessionReady(true); return docs;
    })();
    return hydrationRef.current;
  }, []);
  useEffect(() => { void ensureDocuments(); void refreshScans(); }, [ensureDocuments]);
  useEffect(() => {
    if (activeDocumentId && window.innerWidth < 1000) document.getElementById('score-desk')?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, [activeDocumentId]);
  useEffect(() => {
    const p = new ScorePlayer({
      onAudioState: (state, message) => { setAudioState(state); setAudioMessage(message || ''); },
      onPosition: beat => { if (!countingRef.current && playingRef.current) countEndedRef.current = false; setPosition(beat); if (!switchingRef.current && sessionRef.current) { sessionRef.current.position = beat; if (!playingRef.current || Date.now() - lastPositionSave.current >= 5000) { lastPositionSave.current = Date.now(); saveRef.current(); } } },
      onState: value => {
        playingRef.current = value; setPlaying(value);
        if (value) setCountInCancelled(false);
        else {
          if (!switchingRef.current && (countingRef.current || countEndedRef.current)) setCountInCancelled(true);
          countingRef.current = false; countEndedRef.current = false; setCountInRemaining(null);
          if (!switchingRef.current) { saveRef.current(); void librarySaver.current?.flush(); }
        }
      },
      onCountIn: remaining => {
        if (remaining !== null && Number.isFinite(remaining)) {
          countingRef.current = true; countEndedRef.current = false; setCountInCancelled(false);
          const displayed = Math.max(0, Math.round(remaining * 1000) / 1000);
          setCountInRemaining(previous => previous === displayed ? previous : displayed);
        } else {
          const wasCounting = countingRef.current; countingRef.current = false; countEndedRef.current = wasCounting;
          setCountInRemaining(null);
          if (wasCounting && !playingRef.current && !switchingRef.current) setCountInCancelled(true);
        }
      },
    });
    player.current = p;
    const save = () => { saveRef.current(); void librarySaver.current?.flush(); };
    const visibility = () => { if (document.visibilityState === 'hidden') save(); };
    window.addEventListener('pagehide', save); document.addEventListener('visibilitychange', visibility);
    return () => { save(); switchingRef.current = true; p.dispose(); player.current = null; request.current?.abort(); window.removeEventListener('pagehide', save); document.removeEventListener('visibilitychange', visibility); switchingRef.current = false; };
  }, []);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 999px)');
    const update = () => { setCompactLayout(media.matches); if (!media.matches) setMobileToolsOpen(false); };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!compactLayout || !mobileToolsOpen) return;
    const panel = toolsRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusable = () => Array.from(panel?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], summary, [tabindex="0"]') ?? []).filter(element => {
      if (!element.checkVisibility()) return false;
      for (let ancestor = element.parentElement; ancestor && ancestor !== panel; ancestor = ancestor.parentElement) {
        if (ancestor instanceof HTMLDetailsElement && !ancestor.open && ancestor.querySelector(':scope > summary') !== element) return false;
      }
      return true;
    });
    const frame = requestAnimationFrame(() => (focusable()[0] ?? panel)?.focus());
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); setMobileToolsOpen(false); return; }
      if (event.key !== 'Tab') return;
      const items = focusable(); const first = items[0]; const last = items.at(-1);
      if (!first || !last) { event.preventDefault(); panel?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || !panel?.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => { cancelAnimationFrame(frame); document.body.style.overflow = previousOverflow; document.removeEventListener('keydown', handleKey, true); toolsTriggerRef.current?.focus({ preventScroll: true }); };
  }, [compactLayout, mobileToolsOpen]);
  function openTools(section: 'practice' | 'review' | 'sound' | 'export' = 'practice') {
    if (!mobileToolsOpen) toolsTriggerRef.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : practiceTriggerRef.current;
    if (section === 'review' && reviewRef.current) reviewRef.current.open = true;
    if (section === 'sound') { const target = document.querySelector<HTMLDetailsElement>('.sound-settings'); if (target) target.open = true; }
    if (section === 'export') { const target = document.querySelector<HTMLDetailsElement>('.export-settings'); if (target) target.open = true; }
    if (compactLayout) setMobileToolsOpen(true);
    const id = section === 'practice' ? 'current-practice' : section + '-settings';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const target = document.getElementById(id);
      if (compactLayout) {
        const panel = toolsRef.current;
        if (panel && target) {
          const headerHeight = panel.querySelector('.mobile-tools-header')?.getBoundingClientRect().height ?? 0;
          panel.scrollTop += target.getBoundingClientRect().top - panel.getBoundingClientRect().top - headerHeight - 12;
        }
      } else target?.scrollIntoView({ block: 'start', behavior: 'instant' });
    }));
  }
  function showOriginal() {
    setMobileToolsOpen(false);
    if (originalRef.current) originalRef.current.open = true;
    requestAnimationFrame(() => { originalRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' }); originalRef.current?.querySelector('summary')?.focus({ preventScroll: true }); });
  }
  function showLibrary() {
    setMobileToolsOpen(false); setLibraryExpanded(true);
    requestAnimationFrame(() => { importButton.current?.scrollIntoView({ block: 'center', behavior: 'instant' }); importButton.current?.focus({ preventScroll: true }); });
  }
  const refreshHealth = useCallback(async () => {
    try { const res = await fetch('/api/health'); if (!res.ok) throw new Error(); const data = await res.json() as Health; if (!data.engine || !data.limits) throw new Error(); setHealth(data); setHealthError(false); }
    catch { setHealth(null); setHealthError(true); }
  }, []);
  useEffect(() => { void refreshHealth(); }, [refreshHealth]);
  useEffect(() => { return () => { if (original?.url.startsWith('blob:')) URL.revokeObjectURL(original.url); }; }, [original]);
  useEffect(() => {
    if (!showKeys) return;
    const before = shortcutTrigger.current;
    function trap(e: KeyboardEvent) {
      if (e.key === 'Escape') { e.preventDefault(); setShowKeys(false); return; }
      if (e.key !== 'Tab') return;
      const buttons = dialogRef.current?.querySelectorAll<HTMLElement>('button, a[href], [tabindex="0"]');
      if (!buttons?.length) return;
      const first = buttons[0]; const last = buttons[buttons.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', trap);
    return () => { document.removeEventListener('keydown', trap); before?.focus(); };
  }, [showKeys]);
  useEffect(() => {
    if (!score || !sessionRef.current) return;
    sessionRef.current = sanitizeSession({ ...sessionRef.current, tempo, transpose, metronome, countIn, partInstruments, muted, solo, loop, loopStart, loopEnd, followRepeats, followMode, followEnabled }, scoreBounds(score));
    saveRef.current();
  }, [score, tempo, transpose, metronome, countIn, partInstruments, muted, solo, loop, loopStart, loopEnd, followRepeats, followMode, followEnabled]);
  useEffect(() => { player.current?.setFollowRepeats(followRepeats); }, [followRepeats, score]);
  useEffect(() => { player.current?.setTempo(tempo); }, [tempo, score]);
  useEffect(() => { player.current?.setTranspose(transpose); }, [transpose, score]);
  useEffect(() => { player.current?.setMetronome(metronome); }, [metronome, score]);
  useEffect(() => { player.current?.setCountIn(countIn); }, [countIn, score]);
  useEffect(() => { if (score) player.current?.setPartInstruments(partInstruments); }, [partInstruments, score]);
  useEffect(() => { if (score) player.current?.setMutedParts(solo ? score.parts.filter(p => p.id !== solo).map(p => p.id) : muted); }, [muted, solo, score]);
  useEffect(() => {
    if (!score) return;
    const start = score.measures[loopStart - 1]?.startBeat ?? 0;
    const last = score.measures[loopEnd - 1];
    player.current?.setLoop(start, last ? last.startBeat + last.duration : score.totalBeats, loop);
  }, [score, loop, loopStart, loopEnd]);
  useEffect(() => {
    if (!score) { setRenderXml(''); return; }
    try { setRenderXml(transpose === 0 ? score.xml : transposeXml(score.xml, transpose)); }
    catch (e) { setNotice({ kind: 'error', text: `移调未应用：${e instanceof Error ? e.message : String(e)}` }); setRenderXml(score.xml); }
  }, [score, transpose]);

  function toggleKeys() {
    if (!showKeys) {
      shortcutTrigger.current = compactLayout && mobileToolsOpen ? practiceTriggerRef.current : document.activeElement as HTMLElement | null;
      setMobileToolsOpen(false);
    }
    setShowKeys(v => !v);
  }
  function persistRecent(next: RecentDocument[]) {
    recentRef.current = next; setRecent(next);
    if (!saveDocuments(browserStorage, next)) setNotice({ kind: 'info', text: '浏览器存储空间不足。这份乐谱仍可练习，请导出 MusicXML 保存。' });
  }
  function saveCurrent() {
    const active = activeRef.current; const current = scoreRef.current; const session = sessionRef.current;
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
    librarySnapshots.current.set(item.id, item);
    const currentState = libraryStates.current.get(item.id);
    if (currentState?.status === 'error' || currentState?.status === 'conflict') {
      void librarySaver.current?.stage(item);
    } else {
      librarySaver.current?.enqueue(item);
    }
    if (!historySuppressed.current && current.xml.length <= 350_000) persistRecent(upsertDocument(recentRef.current, item));
  }
  saveRef.current = saveCurrent;
  function clearHistory() {
    historySuppressed.current = true; persistRecent([]);
    setNotice({ kind: 'info', text: '已清除最近打开历史。已保存的谱和服务器扫描档案均未删除，本页仍会保存到本机谱库。' });
  }
  function configurePlayer(next: Score, session: PracticeSession) {
    const p = player.current; if (!p) return;
    p.load(next); p.setTempo(session.tempo); p.setTranspose(session.transpose); p.setMetronome(session.metronome); p.setCountIn(session.countIn); p.setPartInstruments(instrumentMap(session.partInstruments ?? {}, next));
    p.setMutedParts(session.solo ? next.parts.filter(part => part.id !== session.solo).map(part => part.id) : session.muted);
    p.setFollowRepeats(session.followRepeats);
    const last = next.measures[session.loopEnd - 1];
    p.setLoop(next.measures[session.loopStart - 1]?.startBeat || 0, last ? last.startBeat + last.duration : next.totalBeats, session.loop);
    p.seek(session.position);
  }
  function activate(next: Score, from: string, id: string, jobId?: string, preserve = false, restoredSession?: unknown, openedAt?: number) {
    if (activeRef.current && activeRef.current.id !== id) saveCurrent();
    const prior = preserve ? sessionRef.current : restoredSession ?? recentRef.current.find(item => item.id === id)?.session;
    const settings = sanitizeSession(prior, scoreBounds(next));
    if (!preserve) historySuppressed.current = false;
    switchingRef.current = true;
    try {
      player.current?.stop(); scoreRef.current = next;
      const opened = openedAt ?? (preserve && activeRef.current?.opened ? activeRef.current.opened : Date.now());
      activeRef.current = { id, source: from, opened, ...(jobId ? { jobId } : {}) }; sessionRef.current = settings;
      configurePlayer(next, settings);
      setScore(next); setSource(from); setActiveDocumentId(id); setPosition(settings.position); setPlaying(false);
      setTempo(settings.tempo); setTranspose(settings.transpose); setMetronome(settings.metronome); setCountIn(settings.countIn); setPartInstruments(instrumentMap(settings.partInstruments ?? {}, next)); setMuted(settings.muted); setSolo(settings.solo);
      setLoop(settings.loop); setLoopStart(settings.loopStart); setLoopEnd(settings.loopEnd); setFollowRepeats(settings.followRepeats);
      setFollowMode(settings.followMode ?? 'scroll'); setFollowEnabled(settings.followEnabled ?? true);
      setJumpMeasure(String(Math.max(1, next.measures.findLastIndex(measure => measure.startBeat <= settings.position) + 1))); setJumpError('');
      setEditingMetadata(false); setRenamingPartId(null); setConfirmOctaveRemoval(false); countingRef.current = false; countEndedRef.current = false; setCountInRemaining(null); setCountInCancelled(false);
      setConfirmMeter(false);
      if (!preserve) {
        const doc = new DOMParser().parseFromString(next.xml, 'application/xml');
        const time = doc.getElementsByTagName('time')[0];
        const beats = Number(time?.getElementsByTagName('beats')[0]?.textContent);
        const beatType = Number(time?.getElementsByTagName('beat-type')[0]?.textContent);
        setMeterMeasure(1); setMeterBeats(Number.isInteger(beats) && beats >= 1 && beats <= 32 ? beats : 4);
        setMeterBeatType([1, 2, 4, 8, 16, 32, 64].includes(beatType) ? beatType : 4);
        setArrangementPreset('none'); setShowInstrumentDetails(false);
        setExportScope('full'); setUndo([]); setSelectedNoteId(null);
      }
    } finally { switchingRef.current = false; }
    saveCurrent();
    if (!preserve) { setLibraryExpanded(false); setMobileToolsOpen(false); setRecognitionWarnings([]); }
  }
  async function openXml(input: string | ArrayBuffer, filename: string, from: string, token: number, explicitId?: string, jobId?: string) {
    await ensureDocuments();
    const parsed = await readScore(input, filename);
    const id = await documentId(parsed.xml, explicitId);
    let remote: RemoteSavedDocument | null = null;
    saveCurrent();
    await librarySaver.current?.flush();
    const state = libraryStates.current.get(id)?.status;
    let pending = (state === 'error' || state === 'conflict') ? librarySnapshots.current.get(id) : undefined;
    if (!pending) {
      const outboxEntry = await getOutboxEntry(id);
      if (outboxEntry) {
        pending = outboxEntry.document;
        librarySnapshots.current.set(id, outboxEntry.document);
        if (outboxEntry.knownUpdatedAt !== undefined) {
          librarySaver.current?.setKnownVersion(id, outboxEntry.knownUpdatedAt);
        }
      }
    }
    try {
      if (!pending) {
        remote = await getSavedDocument(id);
        if (remote && typeof remote.updatedAt === 'number') {
          librarySaver.current?.setKnownVersion(id, remote.updatedAt);
        }
        libraryStates.current.delete(id);
      }
    }
    catch (error) {
      // An unread saved correction is not a failed write. Do not activate an
      // older import/cache and then offer to overwrite the unread version.
      throw new Error(`本机谱库读取失败，未打开这份谱，以免覆盖已保存的校正版。请检查本机服务后重新打开。${error instanceof Error ? error.message : ''}`);
    }
    const saved = pending ?? remote ?? recentRef.current.find(item => item.id === id);
    const next = saved && saved.xml !== parsed.xml ? await readScore(saved.xml, 'saved.musicxml') : parsed;
    if (generation.current !== token) return;
    if (!pending && remote) {
      librarySaver.current?.setSaved(
        { id, title: next.title, composer: next.composer, source: remote.source, xml: remote.xml, opened: remote.opened, session: sanitizeSession(remote.session, scoreBounds(next)), ...(remote.jobId ? { jobId: remote.jobId } : {}) },
        typeof remote.updatedAt === 'number' ? remote.updatedAt : undefined,
      );
    }
    activate(next, saved?.source || from, id, saved?.jobId || jobId, false, saved?.session, saved?.opened);
    setOriginal(null);
  }
  async function loadDemo(repeatStudy = false) {
    request.current?.abort(); const controller = new AbortController(); request.current = controller; const token = ++generation.current;
    setBusy('正在打开原创示例…'); setNotice(null);
    try { const filename = repeatStudy ? 'repeat-study.musicxml' : 'first-light.musicxml'; const res = await fetch(`/samples/${filename}`, { signal: controller.signal }); if (!res.ok) throw new Error(`示例暂不可用，HTTP ${res.status}`); await openXml(await res.text(), filename, repeatStudy ? '反复练习示例 · CC0' : '原创示例 · CC0', token); if (generation.current === token) setOriginal(null); }
    catch (e) { if (!controller.signal.aborted) setNotice({ kind: 'error', text: e instanceof Error ? e.message : '示例载入失败' }); }
    finally { if (generation.current === token) setBusy(''); }
  }
  async function waitForJob(id: string, controller: AbortController, token: number): Promise<ScanResult> {
    const started = Date.now();
    while (!controller.signal.aborted && generation.current === token) {
      if (Date.now() - started > 10 * 60 * 1000) throw new Error('已等待 10 分钟。浏览器停止等待，请检查本地识别服务。');
      const response = await fetch(`/api/jobs/${encodeURIComponent(id)}`, { signal: controller.signal });
      if (!response.ok) throw new Error(await responseError(response));
      const job = await response.json() as ScanResult;
      if (job.status === 'error') throw new Error(job.message || 'Audiveris 未能识别这份文件。请尝试清晰、平整的谱页。');
      if (job.status === 'done') return job;
      setBusy(job.status === 'queued' ? '识别任务排队中，请稍候…' : `Audiveris 正在识别${job.message ? `：${job.message}` : '，复杂谱页可能需要几分钟…'}`);
      await new Promise<void>((resolve, reject) => { const timer = window.setTimeout(() => { controller.signal.removeEventListener('abort', abort); resolve(); }, 1200); const abort = () => { window.clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); }; controller.signal.addEventListener('abort', abort, { once: true }); });
    }
    throw new DOMException('Aborted', 'AbortError');
  }
  async function loadRecognizedJob(id: string, job: ScanResult, name: string, controller: AbortController, token: number) {
    const response = await fetch(`/api/jobs/${encodeURIComponent(id)}/score`, { signal: controller.signal });
    if (!response.ok) throw new Error(await responseError(response));
    const filename = /mxl/i.test(response.headers.get('content-type') || '') || /\.mxl(?:$|\?)/i.test(job.resultUrl || '') ? 'recognized.mxl' : 'recognized.musicxml';
    await openXml(await response.arrayBuffer(), filename, `本地识别 · ${name}`, token, `job:${id}`, id);
  }
  async function importFile(file: File) {
    request.current?.abort(); const controller = new AbortController(); request.current = controller; const token = ++generation.current;
    setNotice(null); setBusy(`正在读取 ${file.name}…`);
    try {
      if (/\.(musicxml|xml|mxl)$/i.test(file.name)) {
        if (file.size > 20 * 1024 * 1024) throw new Error('MusicXML 文件上限为 20 MB。请先拆分乐谱。');
        await openXml(await file.arrayBuffer(), file.name, file.name, token); if (generation.current === token) setOriginal(null); return;
      }
      if (!/\.(pdf|png|jpe?g)$/i.test(file.name)) throw new Error('请选择 MusicXML、MXL、PDF、PNG 或 JPEG 文件。');
      if (health && file.size > health.limits.maxUploadBytes) throw new Error(`文件超过后端上限 ${Math.round(health.limits.maxUploadBytes / 1024 / 1024)} MB。`);
      if (health && !health.engine.available) throw new Error(`本地 Audiveris 尚未就绪。${health.engine.detail || '请在终端执行 npm run setup:omr，然后重新启动服务。'} MusicXML 文件仍可直接导入。`);
      const body = new FormData(); body.append('file', file);
      setBusy('正在提交本地 Audiveris 识别…');
      const response = await fetch('/api/recognize', { method: 'POST', body, signal: controller.signal });
      if (!response.ok) throw new Error(await responseError(response));
      const queued = await response.json() as { id: string; reused?: boolean };
      if (!queued.id || !validJobId(queued.id)) throw new Error('识别服务未返回有效任务编号。');
      if (queued.reused) setBusy('找到同一份扫描，正在恢复已有结果…');
      const job = await waitForJob(queued.id, controller, token);
      await loadRecognizedJob(queued.id, job, file.name, controller, token);
      void refreshScans();
      if (generation.current === token) {
        setOriginal({ url: URL.createObjectURL(file), name: file.name, pdf: /\.pdf$/i.test(file.name), jobId: queued.id });
        if (reviewRef.current) reviewRef.current.open = true;
        openTools('review');
        setRecognitionWarnings(job.warnings ?? []);
        setNotice({ kind: 'info', text: '识别结果已载入。请在识谱校对中对照原稿检查音高、节奏与声部。' });
      }
    } catch (e) { if (!controller.signal.aborted && generation.current === token) setNotice({ kind: 'error', text: e instanceof Error ? e.message : '导入失败，请重试。' }); }
    finally { if (generation.current === token) setBusy(''); }
  }
  async function retryWithoutCover(job: ScanJob) {
    if (!validJobId(job.id) || job.status !== 'error' || !/\.pdf$/i.test(job.originalName || '')) return;
    request.current?.abort(); const controller = new AbortController(); request.current = controller; const token = ++generation.current;
    setRetryingJob(job.id); setBusy('原 PDF 不改，正在识别第 2 页起…');
    setNotice({ kind: 'info', text: '将跳过第 1 页封面，创建新的识别任务。原 PDF 和失败档案均保留，不保证后续页一定识别成功。' });
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skipFirstPage: true }), signal: controller.signal });
      if (!response.ok) throw new Error(await responseError(response));
      const queued = await response.json() as ScanResult;
      if (!validJobId(queued.id)) throw new Error('重试服务未返回有效任务编号。');
      void refreshScans();
      const completed = await waitForJob(queued.id, controller, token);
      await loadRecognizedJob(queued.id, completed, `${job.originalName || '扫描 PDF'} · 已跳过第 1 页`, controller, token);
      if (generation.current === token) {
        setOriginal({ url: `/api/jobs/${encodeURIComponent(queued.id)}/original`, name: job.originalName || '原始 PDF', pdf: true, jobId: queued.id });
        if (reviewRef.current) reviewRef.current.open = true;
        openTools('review');
        setRecognitionWarnings(completed.warnings ?? []);
        setNotice({ kind: 'info', text: '已载入从第 2 页开始的识别结果。完整原 PDF 保留，请在识谱校对中检查原稿。' });
      }
    } catch (e) { if (!controller.signal.aborted && generation.current === token) setNotice({ kind: 'error', text: `跳过封面重试失败：${e instanceof Error ? e.message : String(e)}` }); }
    finally { if (generation.current === token) setBusy(''); setRetryingJob(null); void refreshScans(); }
  }
  async function refreshLibrary() {
    try { setSavedDocuments(await listSavedDocuments()); setLibraryError(''); }
    catch (error) { setLibraryError(error instanceof Error ? error.message : '本机谱库暂不可用。'); }
  }
  function retryLibrarySave(force = false) {
    const active = activeRef.current; if (!active) return;
    const isConflict = libraryStates.current.get(active.id)?.status === 'conflict';
    const snapshot = librarySnapshots.current.get(active.id);
    if (isConflict || force) {
      if (snapshot) {
        librarySaver.current?.retry(active.id, true);
        librarySaver.current?.enqueue(snapshot);
      } else {
        librarySaver.current?.retry(active.id, true);
      }
    } else {
      if (snapshot) librarySaver.current?.enqueue(snapshot);
      else librarySaver.current?.retry(active.id);
    }
  }
  async function openSavedDocument(id: string) {
    saveCurrent(); request.current?.abort(); const controller = new AbortController(); request.current = controller; const token = ++generation.current;
    setBusy('正在打开已保存的谱…'); setNotice(null);
    try {
      await ensureDocuments(); await librarySaver.current?.flush();
      const state = libraryStates.current.get(id)?.status;
      let pending = (state === 'error' || state === 'conflict') ? librarySnapshots.current.get(id) : undefined;
      if (!pending) {
        const outboxEntry = await getOutboxEntry(id);
        if (outboxEntry) {
          pending = outboxEntry.document;
          librarySnapshots.current.set(id, outboxEntry.document);
          if (outboxEntry.knownUpdatedAt !== undefined) {
            librarySaver.current?.setKnownVersion(id, outboxEntry.knownUpdatedAt);
          }
        }
      }
      let saved: RecentDocument | RemoteSavedDocument;
      if (pending) {
        saved = pending;
      } else {
        const remote = await getSavedDocument(id, controller.signal);
        if (!remote) throw new Error('本机谱库中已找不到这份乐谱。');
        saved = remote;
        if (typeof remote.updatedAt === 'number') {
          librarySaver.current?.setKnownVersion(id, remote.updatedAt);
        }
        libraryStates.current.delete(id);
      }
      const parsed = await readScore(saved.xml, 'saved.musicxml');
      if (generation.current !== token) return;
      if (!pending) {
        librarySaver.current?.setSaved(
          { id, title: parsed.title, composer: parsed.composer, source: saved.source, xml: saved.xml, opened: saved.opened, session: sanitizeSession(saved.session, scoreBounds(parsed)), ...(saved.jobId ? { jobId: saved.jobId } : {}) },
          typeof (saved as RemoteSavedDocument).updatedAt === 'number' ? (saved as RemoteSavedDocument).updatedAt : undefined,
        );
      }
      activate(parsed, saved.source, saved.id, saved.jobId, false, saved.session, saved.opened); setOriginal(null);
      if (saved.jobId) await restoreOriginal(saved.jobId, saved.source, token, controller.signal);
    } catch (error) { if (!controller.signal.aborted && generation.current === token) setNotice({ kind: 'error', text: error instanceof Error ? error.message : '已存乐谱打开失败。' }); }
    finally { if (generation.current === token) setBusy(''); }
  }
  async function openRecent(item: RecentDocument) {
    request.current?.abort(); const controller = new AbortController(); request.current = controller; const token = ++generation.current;
    setNotice(null); setBusy('正在恢复本地乐谱…');
    try { await openXml(item.xml, 'recent.musicxml', item.source, token, item.id, item.jobId); if (item.jobId) await restoreOriginal(item.jobId, item.source, token, controller.signal); }
    catch (e) { if (!controller.signal.aborted && generation.current === token) setNotice({ kind: 'error', text: `无法恢复乐谱：${e instanceof Error ? e.message : String(e)}` }); }
    finally { if (generation.current === token) setBusy(''); }
  }
  async function refreshScans() {
    setScanBusy(true); setScanError('');
    try {
      const res = await fetch('/api/jobs'); if (!res.ok) throw new Error(await responseError(res));
      const data = await res.json() as { jobs: ScanJob[]; retentionDays: number };
      if (!Array.isArray(data.jobs)) throw new Error('扫描列表格式无效。');
      setScanJobs(data.jobs.filter(job => typeof job.id === 'string' && validJobId(job.id)).slice(0, 100));
      setScanRetention(Number.isFinite(data.retentionDays) ? data.retentionDays : 7);
    } catch (e) { setScanError(e instanceof Error ? e.message : '无法获取扫描档案。'); }
    finally { setScanBusy(false); }
  }
  async function restoreOriginal(jobId: string, name: string, token: number, signal: AbortSignal) {
    if (!validJobId(jobId) || deletedJobs.current.has(jobId)) return;
    const url = `/api/jobs/${encodeURIComponent(jobId)}/original`;
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) { if (generation.current === token) setNotice({ kind: 'info', text: '乐谱已打开，但原稿已删除、过期或不可读取。已保存的校正版仍可练习和导出。' }); return; }
      const mime = res.headers.get('content-type') || ''; await res.body?.cancel();
      const metadata = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { signal }).then(response => response.ok ? response.json() as Promise<ScanResult> : null).catch(() => null);
      if (generation.current === token && metadata?.warnings) setRecognitionWarnings(metadata.warnings);
      if (!/^image\/(png|jpeg)/i.test(mime) && !/^application\/pdf/i.test(mime)) return;
      if (generation.current === token && !deletedJobs.current.has(jobId)) setOriginal({ url, name, pdf: /^application\/pdf/i.test(mime), jobId });
    } catch (e) { if (!signal.aborted && generation.current === token) setNotice({ kind: 'info', text: `乐谱已打开，原稿暂时不可读取：${e instanceof Error ? e.message : String(e)}` }); }
  }
  async function openScan(job: ScanJob) {
    if (!validJobId(job.id) || job.status !== 'done') return;
    await ensureDocuments();
    if (savedDocuments.some(item => item.id === `job:${job.id}`)) { await openSavedDocument(`job:${job.id}`); if (activeRef.current?.id === `job:${job.id}`) openTools('review'); return; }
    const corrected = recentRef.current.find(item => item.jobId === job.id);
    if (corrected) { await openRecent(corrected); if (activeRef.current?.id === corrected.id) openTools('review'); return; }
    request.current?.abort(); const controller = new AbortController(); request.current = controller; const token = ++generation.current;
    setBusy('正在打开扫描档案…'); setNotice(null);
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(job.id)}/score`, { signal: controller.signal });
      if (!res.ok) throw new Error(await responseError(res));
      await openXml(await res.arrayBuffer(), 'scan.musicxml', `本地识别 · ${job.originalName || '历史扫描'}`, token, `job:${job.id}`, job.id);
      await restoreOriginal(job.id, job.originalName || '历史扫描', token, controller.signal);
      if (generation.current === token) openTools('review');
    } catch (e) { if (!controller.signal.aborted && generation.current === token) setNotice({ kind: 'error', text: `扫描档案打开失败：${e instanceof Error ? e.message : String(e)}` }); }
    finally { if (generation.current === token) setBusy(''); }
  }
  async function deleteScan(job: ScanJob) {
    if (!validJobId(job.id)) return; setDeletingJob(job.id); setScanError('');
    try {
      const res = await fetch(`/api/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
      if (!res.ok) { const message = await responseError(res); throw new Error(res.status === 409 ? `${message} 请稍后刷新再重试。` : message); }
      deletedJobs.current.add(job.id);
      setScanJobs(jobs => jobs.filter(item => item.id !== job.id)); setDeleteJobId(null);
      setOriginal(current => current?.jobId === job.id ? null : current);
      setNotice({ kind: 'info', text: '已删除扫描结果和原稿。本机谱库与浏览器中的校正版没有删除，仍可练习和导出。' });
    } catch (e) { setScanError(`删除失败：${e instanceof Error ? e.message : String(e)}`); }
    finally { setDeletingJob(null); }
  }
  async function saveMetadata() {
    const current = scoreRef.current; const active = activeRef.current; if (!current || !active) return;
    try {
      const doc = new DOMParser().parseFromString(current.xml, 'application/xml');
      if (doc.querySelector('parsererror')) throw new Error('原始 MusicXML 无法解析。');
      const root = doc.documentElement;
      let work = Array.from(root.children).find(el => el.tagName === 'work');
      if (!work) { work = doc.createElement('work'); root.insertBefore(work, root.firstChild); }
      let title = Array.from(work.children).find(el => el.tagName === 'work-title');
      if (!title) { title = doc.createElement('work-title'); work.appendChild(title); }
      title.textContent = titleDraft.trim().slice(0, 200) || '未命名乐谱';
      let identification = Array.from(root.children).find(el => el.tagName === 'identification');
      if (!identification) { identification = doc.createElement('identification'); root.insertBefore(identification, work.nextSibling); }
      let composer = Array.from(identification.children).find(el => el.tagName === 'creator' && el.getAttribute('type') === 'composer');
      if (!composer) { composer = doc.createElement('creator'); composer.setAttribute('type', 'composer'); identification.appendChild(composer); }
      composer.textContent = composerDraft.trim().slice(0, 200);
      const next = await readScore(new XMLSerializer().serializeToString(doc), 'metadata.musicxml');
      if (scoreRef.current !== current) return;
      activate(next, active.source, active.id, active.jobId, true);
      setNotice({ kind: 'info', text: '已保存曲名与作者，文档编号和练习设置不变。MusicXML 与 MIDI 导出会使用新曲名。' });
    } catch (e) { setNotice({ kind: 'error', text: `保存失败：${e instanceof Error ? e.message : String(e)}` }); }
  }
  const instrumentWarnings = useMemo(() => score ? getInstrumentWarnings(score, partInstruments) : [], [score, partInstruments]);
  function applyInstrumentMap(map: Record<string, InstrumentId>, message: string) {
    if (!score) return;
    const next = instrumentMap(map, score);
    const changed = score.parts.some(part => (partInstruments[part.id] ?? DEFAULT_INSTRUMENT) !== (next[part.id] ?? DEFAULT_INSTRUMENT));
    if (!changed) return;
    player.current?.setPartInstruments(next); setPartInstruments(next);
    if (sessionRef.current) { sessionRef.current = { ...sessionRef.current, partInstruments: { ...next } }; saveCurrent(); }
    setNotice({ kind: 'info', text: message });
  }
  function applyArrangement(value: string) {
    if (!score) return;
    if (value === 'none') { setArrangementPreset('none'); return; }
    if (!ARRANGEMENTS.some(item => item.id === value)) return;
    try {
      const next = getArrangementMap(score, value as ArrangementPreset);
      applyInstrumentMap(next, '整首配器已更新，按播放继续。速度、播放位置、只听、静音和循环设置保留。');
      setArrangementPreset(value);
    } catch (e) { setNotice({ kind: 'error', text: `配器更新失败：${e instanceof Error ? e.message : String(e)}` }); }
  }
  function applyAllInstruments(value: string) {
    if (!score || !isInstrumentId(value)) return;
    try {
      const next = allPartsInstrumentMap(score, value);
      applyInstrumentMap(next, '全部声部音色已更新，按播放继续。其他练习设置保留。');
      setArrangementPreset('none');
    } catch (e) { setNotice({ kind: 'error', text: `配器更新失败：${e instanceof Error ? e.message : String(e)}` }); }
  }
  function changePartInstrument(partId: string, value: string) {
    if (!score || !isInstrumentId(value)) return;
    const part = score.parts.find(item => item.id === partId);
    if (!part || (value === 'drums' && !part.notes.some(note => note.percussion !== undefined))) return;
    if ((partInstruments[partId] ?? DEFAULT_INSTRUMENT) === value) return;
    setArrangementPreset('none');
    applyInstrumentMap({ ...partInstruments, [partId]: value }, '音色已更换，按播放继续。播放位置、校正乐谱和其他声部设置保留。');
  }
  const openOctaveCount = useMemo(() => { if (!score) return 0; try { return inspectOpenOctaveShifts(score.xml); } catch { return 0; } }, [score]);
  function requestMeterCorrection() {
    if (!score || !Number.isInteger(meterMeasure) || meterMeasure < 1 || meterMeasure > score.measures.length || !Number.isInteger(meterBeats) || meterBeats < 1 || meterBeats > 32 || ![1, 2, 4, 8, 16, 32, 64].includes(meterBeatType)) {
      setNotice({ kind: 'error', text: '请选择有效起点小节、1 至 32 的整数分子和支持的拍号分母。' }); return;
    }
    setConfirmMeter(true);
  }
  async function correctMeter() {
    const current = scoreRef.current; const active = activeRef.current; if (!current || !active) return;
    try {
      const edited = await readScore(updateTimeSignatureXml(current.xml, meterBeats, meterBeatType, { measure: meterMeasure }), 'meter-corrected.musicxml');
      if (scoreRef.current !== current) return;
      setUndo(items => [...items.slice(-11), current.xml]); activate(edited, active.source, active.id, active.jobId, true);
      setNotice({ kind: 'info', text: `已从第 ${meterMeasure} 小节校正拍号为 ${meterBeats}/${meterBeatType}，后续原有拍号变化保留。音符时值未自动修复，请对照原稿核对，可在音符校正中撤销。` });
    } catch (e) { setNotice({ kind: 'error', text: `拍号校正失败：${e instanceof Error ? e.message : String(e)}` }); }
  }
  async function removeOpenOctaves() {
    const current = scoreRef.current; const active = activeRef.current; if (!current || !active) return;
    try {
      const edited = await readScore(removeOpenOctaveShiftsXml(current.xml), 'corrected.musicxml');
      if (scoreRef.current !== current) return;
      setUndo(items => [...items.slice(-11), current.xml]); activate(edited, active.source, active.id, active.jobId, true);
      setNotice({ kind: 'info', text: '已从浏览器校正版移除未闭合八度线，音高和原始扫描文件未改动。可在音符校正中撤销。' });
    } catch (e) { setNotice({ kind: 'error', text: `移除失败：${e instanceof Error ? e.message : String(e)}` }); }
  }
  function beginPartRename(partId: string) {
    const current = scoreRef.current; const part = current?.parts.find(item => item.id === partId);
    if (!current || !part?.sourcePartId) return;
    if (renamingPartId === partId) { setRenamingPartId(null); return; }
    const doc = new DOMParser().parseFromString(current.xml, 'application/xml');
    const source = Array.from(doc.getElementsByTagName('score-part')).find(item => item.getAttribute('id') === part.sourcePartId);
    setPartNameDraft(source?.getElementsByTagName('part-name')[0]?.textContent || part.name);
    setRenamingPartId(partId);
  }
  async function renamePart() {
    const current = scoreRef.current; const active = activeRef.current;
    const part = current?.parts.find(item => item.id === renamingPartId);
    if (!current || !active || !part?.sourcePartId) return;
    try {
      const edited = await readScore(updatePartNameXml(current.xml, part.sourcePartId, partNameDraft), 'renamed.musicxml');
      if (scoreRef.current !== current) return;
      setUndo(items => [...items.slice(-11), current.xml]); activate(edited, active.source, active.id, active.jobId, true);
      setNotice({ kind: 'info', text: '已保存源声部名称，音符和练习设置未改。MusicXML 导出会保留新名称，同一源声部拆出的谱表会一起更新。' });
    } catch (e) { setNotice({ kind: 'error', text: `改名失败：${e instanceof Error ? e.message : String(e)}` }); }
  }
  const currentSaveState = activeDocumentId ? saveStates[activeDocumentId] : undefined;
  const reviewWarnings = useMemo(() => [...new Set([...(score?.warnings ?? []), ...recognitionWarnings])], [score, recognitionWarnings]);
  const libraryDocuments = useMemo(() => {
    type Item = { id: string; title: string; opened: number; jobId?: string; state: 'saved' | 'saving' | 'unsaved' | 'cached' | 'scan'; recent?: RecentDocument; scan?: ScanJob };
    const items = new Map<string, Item>();
    for (const doc of recent) items.set(doc.id, { id: doc.id, title: doc.title, opened: doc.opened, jobId: doc.jobId, state: 'cached', recent: doc });
    for (const doc of savedDocuments) items.set(doc.id, { ...items.get(doc.id), id: doc.id, title: doc.title, opened: doc.opened, jobId: doc.jobId, state: 'saved' });
    for (const [id, state] of Object.entries(saveStates)) {
      const doc = librarySnapshots.current.get(id); if (!doc) continue;
      items.set(id, { ...items.get(id), id, title: doc.title, opened: doc.opened, jobId: doc.jobId, state: state.status === 'saved' ? 'saved' : state.status === 'saving' ? 'saving' : 'unsaved' });
    }
    for (const job of scanJobs) {
      if (job.status !== 'done' || [...items.values()].some(item => item.jobId === job.id || item.id === 'job:' + job.id)) continue;
      const id = 'job:' + job.id;
      items.set(id, { id, title: job.originalName || '历史扫描', opened: new Date(job.createdAt).getTime(), jobId: job.id, state: 'scan', scan: job });
    }
    return [...items.values()].sort((a, b) => b.opened - a.opened);
  }, [recent, savedDocuments, saveStates, scanJobs]);
  const currentMeasureIndex = score ? Math.max(0, score.measures.findLastIndex(m => m.startBeat <= position + 0.001)) : 0;
  const soloIndex = score?.parts.findIndex(part => part.id === solo) ?? -1;
  const effectiveMutedCount = score?.parts.filter(part => muted.includes(part.id)).length ?? 0;
  const allPartsMuted = !!score && soloIndex < 0 && score.parts.length > 0 && effectiveMutedCount === score.parts.length;
  const practiceSummary = `${soloIndex >= 0 && score ? `只听 ${displayPartName(score.parts[soloIndex].name, soloIndex)}` : effectiveMutedCount ? `已静音 ${effectiveMutedCount} 部` : '全部声部'} · ${loop ? `循环 ${loopStart} 至 ${loopEnd} 小节` : '整首播放'} · ${transpose ? `移调 ${transpose > 0 ? '+' : ''}${transpose} 半音` : '原调'}`;
  const baseTempo = score && Number.isFinite(score.tempo) && score.tempo > 0 ? score.tempo : 100;
  const slowTempo = Math.max(30, Math.min(240, Math.round(baseTempo * .75)));
  const fullTempo = Math.max(30, Math.min(240, Math.round(baseTempo)));
  const quickLoopLength = score ? Math.min(4, score.measures.length - currentMeasureIndex) : 0;
  useEffect(() => { if (!jumpFocused.current) { setJumpMeasure(String(currentMeasureIndex + 1)); setJumpError(''); } }, [currentMeasureIndex, score]);
  const allNotes = useMemo(() => score?.parts.flatMap(part => part.notes) || [], [score]);
  const selectedNote = allNotes.find(n => n.id === selectedNoteId);
  const visibleNotes = useMemo(() => allNotes.filter(n => n.measure === currentMeasureIndex + 1), [allNotes, currentMeasureIndex]);
  const selectNote = useCallback((id: string) => { setSelectedNoteId(id); const n = scoreRef.current?.parts.flatMap(p => p.notes).find(note => note.id === id); if (n) setEditPitch(n.midi); }, []);
  const seek = useCallback((beat: number) => { player.current?.seek(beat); setPosition(beat); }, []);
  const togglePlay = useCallback(async () => {
    if (!scoreRef.current) return;
    try { if (playing || audioState === 'loading') player.current?.pause(); else await player.current?.play(); }
    catch (e) { setNotice({ kind: 'error', text: `无法播放：${e instanceof Error ? e.message : String(e)}` }); }
  }, [playing, audioState]);
  function jumpToMeasure() {
    if (!score) return;
    const number = Number(jumpMeasure);
    if (!jumpMeasure.trim() || !Number.isInteger(number) || number < 1 || number > score.measures.length) { setJumpError(`请输入 1 至 ${score.measures.length} 的整数小节号。`); return; }
    setJumpError(''); seek(score.measures[number - 1].startBeat);
  }
  function practiceCurrentSegment() {
    if (!score) return;
    const start = currentMeasureIndex + 1;
    setLoopStart(start); setLoopEnd(Math.min(score.measures.length, start + 3)); setLoop(true);
  }
  function skipMeasure(direction: number) { if (!score) return; const index = Math.max(0, Math.min(score.measures.length - 1, currentMeasureIndex + direction)); seek(score.measures[index].startBeat); }
  useEffect(() => {
    function keydown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (showKeys || (compactLayout && mobileToolsOpen) || target.closest('input, select, textarea, button, [contenteditable="true"]') || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'Space') { e.preventDefault(); void togglePlay(); }
      if (!score) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); const index = Math.max(0, Math.min(score.measures.length - 1, currentMeasureIndex + (e.key === 'ArrowRight' ? 1 : -1))); seek(score.measures[index].startBeat); }
      if (e.key === 'Home') { e.preventDefault(); seek(0); }
      if (e.key.toLowerCase() === 'm') setMetronome(v => !v);
      if (e.key.toLowerCase() === 'l') setLoop(v => !v);
      if (e.key === '?') { shortcutTrigger.current = document.activeElement as HTMLElement | null; setShowKeys(true); }
    }
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  }, [togglePlay, score, currentMeasureIndex, seek, showKeys, compactLayout, mobileToolsOpen]);
  async function correctNote() {
    if (!score || !selectedNote || !Number.isInteger(editPitch) || editPitch < 0 || editPitch > 127) return;
    try {
      const previous = score.xml;
      const corrected = await readScore(updateNoteXml(score.xml, selectedNote.id, editPitch), 'corrected.musicxml');
      if (scoreRef.current !== score) return;
      setUndo(items => [...items.slice(-11), previous]); const active = activeRef.current;
      if (active) activate(corrected, source, active.id, active.jobId, true);
      setNotice({ kind: 'info', text: `已将第 ${selectedNote.measure} 小节的 ${pitchName(selectedNote.midi)} 改为 ${pitchName(editPitch)}。播放已暂停，保留练习位置。` });
    } catch (e) { setNotice({ kind: 'error', text: `校正失败：${e instanceof Error ? e.message : String(e)}` }); }
  }
  async function undoCorrection() {
    const xml = undo[undo.length - 1]; if (!xml) return;
    const current = scoreRef.current;
    try { const restored = await readScore(xml, 'undo.musicxml'); if (scoreRef.current !== current) return; const active = activeRef.current; if (active) activate(restored, source, active.id, active.jobId, true); setUndo(items => items.slice(0, -1)); setSelectedNoteId(null); setNotice({ kind: 'info', text: '已撤销上一次乐谱修改。' }); }
    catch (e) { setNotice({ kind: 'error', text: `撤销失败：${e instanceof Error ? e.message : String(e)}` }); }
  }
  async function exportScore(format: 'xml' | 'midi' | 'wav') {
    if (!score) return; setExporting(true);
    try {
      await new Promise(resolve => window.setTimeout(resolve, 0));
      const filename = (score.title || 'score').replace(/[\\/:*?"<>|]/g, '_');
      const excerpt = format !== 'xml' && exportScope === 'excerpt';
      if (excerpt && (!Number.isInteger(loopStart) || !Number.isInteger(loopEnd) || loopStart < 1 || loopEnd < loopStart || loopEnd > score.measures.length)) throw new Error('请选择有效的整数起止小节后再导出。');
      const options = { tempo, transpose, followRepeats, partInstruments, mutedParts: solo ? score.parts.filter(p => p.id !== solo).map(p => p.id) : muted, ...(excerpt ? { measureRange: { start: loopStart, end: loopEnd } } : {}) };
      const audioFilename = excerpt ? `${filename}-小节-${loopStart}-${loopEnd}` : filename;
      if (format === 'xml') download(transposeXml(score.xml, transpose), 'application/vnd.recordare.musicxml+xml', `${filename}.musicxml`);
      if (format === 'midi') download(exportMidi(score, options), 'audio/midi', `${audioFilename}.mid`);
      if (format === 'wav') download(await scoreToWav(score, options), 'audio/wav', `${audioFilename}.wav`);
      setNotice({ kind: 'info', text: format === 'xml' ? '已导出整首 MusicXML，保留校正、移调和反复记号，不按所选小节截取。' : `已生成 ${format.toUpperCase()} 文件。${excerpt ? `第 ${loopStart} 至 ${loopEnd} 小节演奏一次，不展开谱面反复。` : '整首使用当前谱面反复设置，不截取手动循环范围。'} 使用当前速度、移调、声部与所选音色，不含预备拍或节拍器。` });
    } catch (e) { setNotice({ kind: 'error', text: `导出失败：${e instanceof Error ? e.message : String(e)}` }); }
    finally { setExporting(false); }
  }
  function drop(e: DragEvent) { e.preventDefault(); setDragging(false); const file = e.dataTransfer.files[0]; if (file) void importFile(file); }
  function changeFile(e: ChangeEvent<HTMLInputElement>) { const file = e.target.files?.[0]; if (file) void importFile(file); e.target.value = ''; }
  function noteLabel(note: ScoreNote) { const part = score?.parts.find(p => p.id === note.partId); const beat = note.beat - (score?.measures[note.measure - 1]?.startBeat || 0) + 1; return `${pitchName(note.midi)} · ${part?.name || note.partId} · 第 ${Number(beat.toFixed(2))} 拍`; }

  return <div className={`app ${dragging ? 'is-dragging' : ''} ${mobileToolsOpen ? 'mobile-tools-open' : ''}`} onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }} onDrop={drop}>
    <a className="skip-link" href="#score-desk">跳到乐谱</a>
    <input ref={fileInput} type="file" className="sr-only" accept=".xml,.musicxml,.mxl,.pdf,.png,.jpg,.jpeg" onChange={changeFile} aria-label="导入乐谱文件" />
    <header className="masthead" inert={compactLayout && mobileToolsOpen ? true : undefined}>
      <a className="brand" href="#" onClick={e => e.preventDefault()} aria-label="谱间 ScoreCraft"><span className="brand-seal">谱</span><span className="brand-name">谱间<span>ScoreCraft</span></span></a>
      <div className="masthead-note">给每一页谱，留一点练习的时间。</div>
      <div className="masthead-actions"><span className="local-badge"><i />本地工作台</span><button className="icon-button" aria-label="键盘快捷键" title="键盘快捷键" onClick={toggleKeys}>?</button></div>
    </header>
    <div className="workspace">
      <aside className={`library ${score ? 'has-active-score' : ''} ${libraryExpanded ? 'expanded' : ''}`} aria-label="谱库与导入" inert={compactLayout && mobileToolsOpen ? true : undefined}><button className="mobile-library-toggle" aria-expanded={!score || libraryExpanded} onClick={() => setLibraryExpanded(value => !value)}>我的乐谱与导入 {libraryExpanded ? '−' : '＋'}</button><div className="library-content">
        <div className="section-heading"><span className="eyebrow">YOUR MUSIC DESK</span><span className="edition">01 / 谱库</span></div>
        <h1>从一页谱开始</h1>
        <p className="library-intro">打开乐谱，听一遍。<br />把难的那一小节，慢慢练熟。</p>
        <button ref={importButton} className="button primary import-button" onClick={() => fileInput.current?.click()}><Icon name="upload" />导入乐谱<span>＋</span></button>
        <p className="file-hint">MusicXML / MXL 直接打开<br />PDF / 图片交给本地 Audiveris</p>
        <div className="import-drop" role="button" tabIndex={0} onClick={() => fileInput.current?.click()} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.current?.click(); } }}><Icon name="file" size={24} /><span>也可以把文件拖到这里</span><small>每次导入一份乐谱</small></div>
        <div className="library-rule" />
        <section className="my-library"><div className="section-heading"><h2>我的乐谱</h2><span className="small-count">{libraryDocuments.length}</span></div><button className="text-button" aria-label="刷新我的乐谱" onClick={() => { void refreshLibrary(); void refreshScans(); }}>刷新乐谱 ↻</button>{libraryError && <p className="scan-error" role="status">{libraryError}</p>}<ul className="saved-document-list">{libraryDocuments.map(item => <li key={item.id} data-document-id={item.id}><button className={activeDocumentId === item.id ? 'recent-item active' : 'recent-item'} aria-label={`打开乐谱：${item.title}`} onClick={() => { if (item.scan) void openScan(item.scan); else if (item.state === 'cached' && item.recent) void openRecent(item.recent); else void openSavedDocument(item.id); }}><Icon name="file"/><span><strong>{item.title || '未命名乐谱'}</strong><small>{({ saved:'已保存',saving:'保存中',unsaved:'未保存',cached:'最近缓存',scan:'扫描已完成' })[item.state]}{item.jobId && scanJobs.some(job => job.id === item.jobId) ? ' · 含扫描档案' : ''}</small></span>{item.state === 'unsaved' && <span className="unsaved-badge">未保存</span>}</button></li>)}</ul>{!libraryDocuments.length && <p className="recent-empty">{sessionReady ? '打开的乐谱会统一留在这里。' : '正在恢复本机谱库…'}</p>}</section>
        <button className="demo-link" onClick={() => void loadDemo()}><span className="demo-note">♫</span><span><strong>先试一页示例</strong><small>First Light · 原创钢琴小品 / CC0</small></span><span>↗</span></button>
        <button className="repeat-demo-link text-button" onClick={() => void loadDemo(true)}>试试反复练习示例 ↗</button>
        <details className="library-management"><summary>谱库管理与导入帮助</summary><p className="micro-copy">乐谱保存在本机谱库；扫描原稿另按 {scanRetention} 天保留。最近缓存不是完整备份。</p>{recent.length > 0 && <button className="text-button clear-history" onClick={clearHistory}>清除本地历史</button>}
        <section className="scan-library" aria-label="本机扫描档案"><div className="section-heading"><button className="scan-heading" aria-label="扫描档案" aria-expanded={scanOpen} onClick={() => { setScanOpen(v => !v); if (!scanOpen) void refreshScans(); }}>扫描档案 <span>{scanOpen ? '−' : '＋'}</span></button><button className="text-button" onClick={() => void refreshScans()} disabled={scanBusy} aria-label="刷新扫描档案">↻</button></div>{scanOpen && <div className="scan-library-body"><p className="micro-copy">本机服务器保留 {scanRetention} 天。删除扫描不会删除浏览器中的校正版。</p>{scanBusy && <p role="status" className="micro-copy">正在读取扫描档案…</p>}{scanError && <p className="scan-error" role="alert">{scanError}</p>}{!scanBusy && !scanJobs.length && !scanError && <p className="micro-copy">还没有扫描档案。</p>}<ul className="scan-list">{scanJobs.map(job => <li key={job.id} data-job-id={job.id}><div className="scan-item-heading"><strong title={job.originalName || '历史扫描'}>{job.originalName || '历史扫描'}</strong><span className={`scan-status ${job.status}`}>{({ queued: '排队', running: '识别中', done: '已完成', error: '失败' })[job.status]}</span></div><small>{new Date(job.createdAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}</small>{job.message && <p className="scan-message">{job.message}</p>}{job.status === 'error' && /\.pdf$/i.test(job.originalName || '') && /(?:五线谱|staff|staves|regular\s*staff)/i.test(job.message || '') && <button className="text-button retry-cover-button" disabled={!!retryingJob} onClick={() => void retryWithoutCover(job)}>{retryingJob === job.id ? '正在跳过封面重试…' : '跳过第1页重试'}</button>}<div className="scan-actions"><button className="text-button" disabled={job.status !== 'done'} aria-label={`打开扫描：${job.originalName || '历史扫描'}`} onClick={() => void openScan(job)}>打开乐谱与原稿 ↗</button>{(job.status === 'done' || job.status === 'error') && <button className="text-button delete-scan" aria-label={`删除扫描：${job.originalName || '历史扫描'}`} onClick={() => setDeleteJobId(job.id)}>删除</button>}</div>{deleteJobId === job.id && <div className="scan-delete-confirm"><p>删除这次扫描的原稿和结果？浏览器校正版不受影响。</p><button className="text-button delete-scan" disabled={!!deletingJob} onClick={() => void deleteScan(job)}>{deletingJob === job.id ? '正在删除…' : '确认删除扫描'}</button><button className="text-button" disabled={!!deletingJob} onClick={() => setDeleteJobId(null)}>取消</button></div>}</li>)}</ul></div>}</section>
        <div className="engine-panel"><div className="engine-heading"><span className={`status-dot ${health?.engine.available ? 'ready' : ''}`} /><strong>{health?.engine.available ? 'Audiveris 已就绪' : healthError ? '识别服务未连接' : health ? 'Audiveris 未安装' : '正在检查识别服务'}</strong><button className="text-button" onClick={() => void refreshHealth()} aria-label="重新检查识别服务">↻</button></div><p>{health?.engine.available ? `图片与 PDF 在本机识别${health.engine.version ? ` · ${health.engine.version}` : ''}。识别后仍需人工核对。` : 'MusicXML 始终可用。扫描识别需要本地后端与 Audiveris，不会用示例代替结果。'}</p>{health && !health.engine.available && <details><summary>如何启用扫描识别</summary><p>{health.engine.detail || '运行 npm run setup:omr，完成后重启本地服务。'}</p><code>npm run setup:omr</code></details>}</div>
        <div className="library-foot">不上传云端 · 无需账号<br /><span>LOCAL-FIRST, NOTE BY NOTE.</span></div>
        <details className="about-panel"><summary>关于谱间 · AGPL-3.0 开源</summary><p>ScoreCraft 以 AGPL-3.0-or-later 许可提供，不提供任何担保。识别和播放结果需要人工核对。</p><p><a href="/api/license" target="_blank" rel="noreferrer">阅读完整许可证 ↗</a><br /><a href="/api/source" download>下载本实例源码</a></p><p>乐谱和练习设置自动保存在本机谱库，保存失败会提示重试。浏览器最近历史仅缓存 4 份、每份最多 35 万字符，不是完整备份。清除最近历史不删除已保存的谱。扫描文件只交给本机 Audiveris，原始图片和 PDF 由扫描档案另保留 7 天。重新打开不会自动播放。</p></details>
        </details></div>
      </aside>
      <main id="score-desk" className="desk" tabIndex={-1} inert={compactLayout && mobileToolsOpen ? true : undefined}>
        <div className="desk-topline"><span className="eyebrow">PRACTICE / 练习</span><span>{score ? `${score.measures.length} 小节 · ${score.parts.length} 声部` : '一页谱，一个专注的下午'}</span></div>
        <div className="score-heading"><div><div className="score-source">{score ? source : '你的下一份乐谱'}</div><h2>{score?.title || '让乐谱，响起来。'}</h2><p>{score ? score.composer || '作曲者未注明' : '读谱、聆听、校正。在同一张桌上。'}</p>{score && <button className="text-button edit-metadata-button" aria-expanded={editingMetadata} onClick={() => { setTitleDraft(score.title); setComposerDraft(score.composer); setEditingMetadata(v => !v); }}>编辑曲名</button>}</div>{score && <button className="icon-button print-button" onClick={() => window.print()} aria-label="打印当前乐谱" title="打印当前乐谱"><Icon name="print" /></button>}</div>
        {score && <div className={`library-save-status ${currentSaveState?.status || ''}`} role="status" aria-live="polite"><span>{currentSaveState?.status === 'saved' ? '已保存到本机谱库' : currentSaveState?.status === 'conflict' ? `保存冲突：${currentSaveState.error || '已被其他窗口更新。'}` : currentSaveState?.status === 'error' ? `保存失败：${currentSaveState.error || '请检查本机服务。'}` : '正在保存…'}</span>{(currentSaveState?.status === 'error' || currentSaveState?.status === 'conflict') && <button className="text-button" onClick={() => retryLibrarySave(currentSaveState?.status === 'conflict')}>{currentSaveState?.status === 'conflict' ? '覆盖保存' : '重试保存'}</button>}{currentSaveState?.outboxError && <small className="outbox-warning">{currentSaveState.outboxError}</small>}{score.xml.length > 350_000 && <small>这份谱较大，不写入浏览器最近历史；请以本机谱库保存状态为准。原始扫描另按 7 天保留。</small>}</div>}
        {score && <div className="score-follow-controls"><button className="text-button return-library-button" onClick={showLibrary}>谱库与导入</button><label htmlFor="follow-mode">跟谱方式</label><select id="follow-mode" value={followMode} onChange={e => setFollowMode(e.target.value === 'page' ? 'page' : 'scroll')}><option value="scroll">向下滚动</option><option value="page">左右翻页</option></select><button className={`toggle-row ${followEnabled ? 'enabled' : ''}`} aria-label="自动跟谱" aria-pressed={followEnabled} onClick={() => setFollowEnabled(value => !value)}><span>自动跟谱</span><span className="switch" /></button></div>}
        {score && editingMetadata && <form className="metadata-form" onSubmit={e => { e.preventDefault(); void saveMetadata(); }}><label>曲名<input name="score-title" value={titleDraft} maxLength={200} onChange={e => setTitleDraft(e.target.value)} /></label><label>作曲者<input name="score-composer" value={composerDraft} maxLength={200} onChange={e => setComposerDraft(e.target.value)} /></label><div><button className="button ink" type="submit">保存曲名与作者</button><button className="text-button" type="button" onClick={() => setEditingMetadata(false)}>取消</button></div></form>}
        {notice && <div className={`notice ${notice.kind}`} role={notice.kind === 'error' ? 'alert' : 'status'}><span>{notice.text}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice(null)}><Icon name="close" size={14} /></button></div>}
        {busy && <div className="job-status" role="status"><span className="job-indicator" /><span>{busy}</span><button className="text-button" onClick={() => { request.current?.abort(); generation.current++; setBusy(''); setNotice({ kind: 'info', text: '已停止浏览器等待。已提交的本地识别任务可能仍在后台运行。' }); }}>停止等待</button></div>}
        {original && <details ref={originalRef} className="original-preview"><summary>查看原谱 <span>{original.name}</span></summary><div className="original-toolbar"><span>{original.jobId ? '原稿由本机扫描档案提供，删除或过期后不可读取。' : '仅在本页保留；识别完成后也可从扫描档案重开。'}</span><a href={original.url} target="_blank" rel="noreferrer">在新标签打开原稿 ↗</a></div>{original.pdf ? <object data={original.url} type="application/pdf" aria-label={`原始 PDF：${original.name}`}><p>浏览器无法内嵌 PDF。请使用上方链接打开原稿。</p></object> : <img src={original.url} alt={`上传的原始乐谱：${original.name}`} />}</details>}
        {score && <div className="review-notice"><button className="text-button" onClick={() => openTools('review')}>校对与原稿{reviewWarnings.length ? ` · ${reviewWarnings.length} 项提示` : ''}</button>{original && <button className="text-button" onClick={showOriginal}>查看原稿对照 ↗</button>}</div>}
        <div className={`score-paper ${score ? 'has-score' : ''}`}>
          <div className="paper-meta"><span>{score ? 'SCORE / 乐谱' : '空白谱架'}</span><span>{score ? `${transpose ? `${transpose > 0 ? '+' : ''}${transpose} 半音` : '原调'} · ${tempo} BPM` : '准备好了，再开始'}</span></div>
          {score ? <Suspense fallback={<div className="score-render-message" role="status">正在加载乐谱排版引擎…</div>}><ScoreView xml={renderXml} measures={score.measures} position={position} playing={playing} followMode={followMode} followEnabled={followEnabled} selectedNoteId={selectedNoteId} onSelectNote={selectNote} onSeek={seek} /></Suspense> : <div className="empty-score"><div className="empty-staff" aria-hidden="true"><span>𝄞</span><i /><i /><i /><i /><i /></div><span className="eyebrow">THE FIRST NOTE IS YOURS</span><h3>把这一页，放上谱架。</h3><p>直接打开 MusicXML，或从纸谱开始识别。<br />还没有文件？听听我们的原创示例。</p><div className="empty-actions"><button className="button ink" onClick={() => fileInput.current?.click()}><Icon name="upload" />选择乐谱</button><button className="button quiet" onClick={() => void loadDemo()}>打开 First Light <span>↗</span></button></div><span className="empty-footnote">示例需要你手动打开，不会冒充扫描结果。</span></div>}
          <div className="paper-footer"><span>谱间 · ScoreCraft</span><span>{score ? `第 ${currentMeasureIndex + 1} / ${score.measures.length} 小节` : 'YOUR PERSONAL PRACTICE DESK'}</span></div>
        </div>
      </main>
      <aside className="inspector" aria-label="练习设置和音符校正">
        <section className="transport" aria-label="播放控制" inert={compactLayout && mobileToolsOpen ? true : undefined}>
          <div className="section-heading transport-heading"><h2>播放与进度</h2><span className="eyebrow">PLAY</span></div>
          <div className="transport-core">
          <div className="timeline"><label className="sr-only" htmlFor="score-position">播放位置</label><input id="score-position" type="range" min="0" max={score?.totalBeats || 1} step="0.05" value={Math.min(position, score?.totalBeats || 1)} onChange={e => seek(Number(e.target.value))} disabled={!score} style={{ '--progress': `${score ? position / Math.max(1, score.totalBeats) * 100 : 0}%` } as CSSProperties} /><div className="timeline-labels"><span>{score ? `小节 ${String(currentMeasureIndex + 1).padStart(2, '0')} / ${String(score.measures.length).padStart(2, '0')}` : '等待载入乐谱'}</span><span>{countInRemaining !== null ? `预备拍 · 第 ${currentMeasureIndex + 1} 小节开始` : playing ? '正在练习' : '按空格开始'}<kbd>space</kbd></span></div></div>
          <div className="transport-row"><div className="playback-buttons"><button className="icon-button" onClick={() => { player.current?.stop(); setPosition(0); }} disabled={!score} aria-label="停止并回到开头" title="停止并回到开头"><Icon name="stop" size={17} /></button><button className="icon-button" onClick={() => skipMeasure(-1)} disabled={!score} aria-label="上一小节" title="上一小节 ←"><Icon name="back" /></button><button className="play-button" onClick={() => void togglePlay()} disabled={!score} aria-label={audioState === 'loading' ? '取消音色加载' : playing ? '暂停' : '播放'} title="空格 播放 / 暂停"><Icon name={playing ? 'pause' : 'play'} size={23} /></button><button className="icon-button" onClick={() => skipMeasure(1)} disabled={!score} aria-label="下一小节" title="下一小节 →"><Icon name="forward" /></button></div><div className="tempo-control"><label htmlFor="tempo">速度</label><div><input id="tempo" type="number" min="30" max="240" value={tempo} onChange={e => setTempo(Math.max(30, Math.min(240, Number(e.target.value) || 30)))} disabled={!score} /><span>BPM</span></div><input aria-label="调整速度" type="range" min="30" max="240" value={tempo} onChange={e => setTempo(Number(e.target.value))} disabled={!score} /></div></div>
          </div>
          <div className="dock-action-row"><div className="practice-state" role="status" aria-live="polite" aria-atomic="true" aria-label="当前练习状态"><span>{score ? practiceSummary : '载入乐谱后开始练习'}</span>{loop && <button className="text-button" onClick={() => setLoop(false)}>结束循环</button>}{allPartsMuted && <div className="practice-silent-warning"><span>全部声部已静音，播放将没有乐谱声音。</span><button className="text-button" onClick={() => { setSolo(null); setMuted([]); }}>恢复全部声部</button></div>}</div>
<div className="mobile-tools-actions"><button ref={practiceTriggerRef} className="mobile-tools-trigger" aria-expanded={mobileToolsOpen} onClick={() => openTools('practice')}>当前练习</button><button className="mobile-tools-trigger" aria-expanded={mobileToolsOpen} onClick={() => openTools('review')}>工具</button></div></div>
          <div className={`count-in-status ${countInRemaining !== null ? 'is-counting' : ''}`} role="status" aria-live="polite" aria-atomic="true">{countInRemaining !== null ? `预备拍 · 还剩 ${countInRemaining} 拍。第 ${currentMeasureIndex + 1} 小节开始。` : countInCancelled ? '预备拍已取消，按播放重新开始。' : ''}</div>
          {audioState === 'loading' && <div className="audio-status" role="status">正在加载本机音色… <button className="text-button" onClick={() => player.current?.pause()}>取消加载</button></div>}
          {audioState === 'error' && <div className="audio-status error" role="alert">{audioMessage || '所选音色加载失败，请按播放重试。不会替换为其他音色。'}</div>}
        </section>
        <div ref={toolsRef} className="inspector-settings" role={compactLayout && mobileToolsOpen ? 'dialog' : undefined} aria-modal={compactLayout && mobileToolsOpen ? true : undefined} aria-label={compactLayout && mobileToolsOpen ? '练习与工具' : undefined} inert={compactLayout && !mobileToolsOpen ? true : undefined} tabIndex={-1}>
<div className="mobile-tools-header"><h2>练习与工具</h2><button className="text-button" aria-label="关闭练习工具" onClick={() => setMobileToolsOpen(false)}>回到乐谱 ×</button></div>
<section id="current-practice" className="current-practice" aria-labelledby="current-practice-title" tabIndex={-1}>
<div className="section-heading"><h2 id="current-practice-title">当前练习</h2><span className="edition">选段 · 慢练</span></div>
<div className="tempo-presets"><span>基准速度 {baseTempo} BPM</span><button className="button quiet" aria-label="放慢至基准速度75%" title={`${slowTempo} BPM`} disabled={!score} onClick={() => setTempo(slowTempo)}>75%</button><button className="button quiet" aria-label="恢复基准速度" title={`${fullTempo} BPM`} disabled={!score} onClick={() => setTempo(fullTempo)}>100%</button><small title="识别未提供速度时使用默认值，并非原稿核实速度。">按谱内基准速度调整。</small></div>
<div className="segment-settings"><section className="inspector-section"><button className="button quiet full-width quick-loop-button" disabled={!score} onClick={practiceCurrentSegment}>从当前小节练{quickLoopLength || 4}小节</button><div className="loop-range"><label>起始小节<input type="number" aria-label="循环起始小节" min="1" max={score?.measures.length || 1} value={loopStart} disabled={!score} onChange={e => { if (!e.target.value) return; const next = Math.max(1, Math.min(score?.measures.length || 1, Math.floor(Number(e.target.value)) || 1)); setLoopStart(next); setLoopEnd(previous => Math.max(previous, next)); }} /></label><span>至</span><label>结束小节<input type="number" aria-label="循环结束小节" min={loopStart} max={score?.measures.length || 1} value={loopEnd} disabled={!score} onChange={e => setLoopEnd(Math.max(loopStart, Math.min(score?.measures.length || 1, Math.floor(Number(e.target.value)) || loopStart)))} /></label></div><button className={`toggle-row ${loop ? 'enabled' : ''}`} disabled={!score} aria-pressed={loop} onClick={() => setLoop(v => !v)}><span>循环这几小节</span><span className="switch" /></button>{score?.playback?.expanded && <><button className={`toggle-row ${followRepeats ? 'enabled' : ''}`} aria-pressed={followRepeats} onClick={() => setFollowRepeats(v => !v)}><span>按谱面反复</span><span className="switch" /></button><p className="micro-copy">手动小节循环优先。关闭循环后按反复设置播放。</p></>}</section></div>
<div className="transpose-settings"><section className="inspector-section"><div className="transpose-row"><label htmlFor="transpose">升调与降调</label><div className="stepper"><button aria-label="降低半音" disabled={!score || transpose <= -12} onClick={() => setTranspose(v => v - 1)}>−</button><output id="transpose">{transpose > 0 ? '+' : ''}{transpose}<small>半音</small></output><button aria-label="升高半音" disabled={!score || transpose >= 12} onClick={() => setTranspose(v => v + 1)}>＋</button></div></div></section></div>
<div className="practice-clicks"><button className={`metronome-button ${metronome ? 'selected' : ''}`} aria-pressed={metronome} disabled={!score} onClick={() => setMetronome(v => !v)} title="节拍器 M"><span className="metronome-symbol">♩</span><span>节拍器</span></button><div className="count-in-control"><button className={`toggle-row ${countIn ? 'enabled' : ''}`} aria-label="播放前预备一小节" aria-pressed={countIn} disabled={!score} onClick={() => setCountIn(value => !value)}><span>播放前预备一小节</span><span className="switch" /></button><p className="micro-copy">按四分音符计拍。预备拍仅用于播放，不写入导出。</p></div></div>
<section className="parts-section"><div className="section-heading"><h3>听哪些声部</h3><button className="text-button" disabled={!score || (!solo && !muted.length)} onClick={() => { setSolo(null); setMuted([]); }}>全部声部</button></div><div className="parts-list">{score ? score.parts.map((part, index) => <div className="part-row" key={part.id}><span className="part-name" title={part.name}>{displayPartName(part.name, index)}</span><button className={`part-button ${muted.includes(part.id) ? 'selected' : ''}`} aria-label={`${muted.includes(part.id) ? '取消静音' : '静音'} ${part.name}`} aria-pressed={muted.includes(part.id)} onClick={() => setMuted(items => items.includes(part.id) ? items.filter(id => id !== part.id) : [...items, part.id])}>{muted.includes(part.id) ? '已静音' : '静音'}</button><button className={`part-button solo ${solo === part.id ? 'selected' : ''}`} aria-label={`独奏 ${part.name}`} aria-pressed={solo === part.id} onClick={() => setSolo(solo === part.id ? null : part.id)}>只听</button></div>) : <p className="micro-copy">载入乐谱后选择声部。</p>}</div></section>
<form className="measure-jump" noValidate onSubmit={event => { event.preventDefault(); jumpToMeasure(); }}><label htmlFor="jump-measure">跳到小节</label><input id="jump-measure" type="number" min={1} max={score?.measures.length || 1} step={1} value={jumpMeasure} disabled={!score} aria-invalid={!!jumpError} aria-describedby={jumpError ? 'jump-measure-error' : undefined} onFocus={() => { jumpFocused.current = true; }} onBlur={() => { jumpFocused.current = false; }} onChange={event => { setJumpMeasure(event.target.value); setJumpError(''); }} /><button className="button quiet" disabled={!score} type="submit">跳转</button>{jumpError && <p id="jump-measure-error" role="alert">{jumpError}</p>}</form></section>
<details id="sound-settings" className="practice-disclosure sound-settings"><summary>声音<small>配器与音色</small></summary><section className="inspector-section"><div className="arrangement-controls"><label htmlFor="arrangement-preset">整首配器</label><select id="arrangement-preset" value={arrangementPreset} disabled={!score} onChange={e => applyArrangement(e.target.value)}><option value="none">当前配器</option>{ARRANGEMENTS.map(item => <option key={item.id} value={item.id}>{item.id === 'piano-bright' ? '全部明亮钢琴' : item.id === 'piano-warm' ? '全部温暖钢琴' : item.id === 'acoustic' ? '吉他与贝斯' : item.label}</option>)}</select><label htmlFor="all-parts-instrument">全部换成</label><select id="all-parts-instrument" value="" disabled={!score} onChange={e => applyAllInstruments(e.target.value)}><option value="" disabled>选择后应用到全部声部</option>{INSTRUMENTS.map(instrument => <option key={instrument.id} value={instrument.id} disabled={instrument.id === 'drums' && (!score || score.parts.some(part => !part.notes.length || !part.notes.every(note => note.percussion !== undefined)))}>{instrument.label}</option>)}</select><p className="micro-copy">选择即应用整首；组合是练习配器，不是对原谱乐器的识别。真实打击乐声部按组合保留鼓组。</p><button className="text-button instrument-details-toggle" aria-expanded={showInstrumentDetails} aria-controls="individual-instrument-controls" onClick={() => setShowInstrumentDetails(value => !value)}>逐个调整音色 {showInstrumentDetails ? '−' : '＋'}</button></div><div id="individual-instrument-controls" hidden={!showInstrumentDetails}>{score?.parts.map((part,index) => <label className="part-instrument-field" key={part.id}><span>{displayPartName(part.name,index)}</span><select aria-label={`声部乐器 ${part.name}`} value={partInstruments[part.id] || DEFAULT_INSTRUMENT} onChange={event => changePartInstrument(part.id,event.target.value)}>{INSTRUMENTS.map(instrument => <option key={instrument.id} value={instrument.id} disabled={instrument.id === 'drums' && !part.notes.some(note => note.percussion !== undefined)}>{instrument.label}</option>)}</select></label>)}</div>{instrumentWarnings.length > 0 && <div className="instrument-warnings" role="status">{instrumentWarnings.map((warning,index) => <p key={index}>{warning}</p>)}</div>}<p className="micro-copy">钢琴、吉他、贝斯和小提琴使用本机录音；铺底与电子鼓为合成音。</p><div className="transport-note"><span className={`status-dot ${audioState === 'ready' ? 'ready' : ''}`} /><a href="/audio/piano/README.md" target="_blank" rel="noreferrer">真实钢琴录音采样 · Salamander / Yamaha C5</a><span className="keyboard-link"><button className="text-button" onClick={toggleKeys}>键盘快捷键 ↗</button></span></div></section></details>
<details ref={reviewRef} id="review-settings" className="practice-disclosure review-settings"><summary>识谱校对<small>{original ? '原稿 · 音符 · 拍号' : '音符 · 拍号 · 名称'}</small></summary><div className="review-intro"><p>对照原稿核对音高、拍号与名称。试听顺畅不代表识别正确。</p>{original && <button className="button quiet full-width" onClick={showOriginal}>查看原稿对照</button>}</div>{score && reviewWarnings.length > 0 && <section className="score-warnings"><h3>这份谱的核对与播放提示 · {reviewWarnings.length} 项</h3><ul>{reviewWarnings.map((warning,index) => <li key={index}>{warning}</li>)}</ul></section>}<section className="inspector-section">{openOctaveCount > 0 ? <><p className="micro-copy">发现 {openOctaveCount} 处未闭合八度线。排版兼容不表示这些线识别正确。</p><button className="button quiet full-width" disabled={!score} onClick={() => setConfirmOctaveRemoval(true)}>移除未闭合八度线</button>{confirmOctaveRemoval && <div className="scan-delete-confirm" role="group" aria-label="确认移除未闭合八度线"><p>仅在对照原谱确认没有这些线后移除，可撤销，不改音高。只修改浏览器校正版，不修改原始扫描。</p><button className="text-button" onClick={() => void removeOpenOctaves()}>确认移除</button><button className="text-button" onClick={() => setConfirmOctaveRemoval(false)}>取消</button></div>}</> : <p className="micro-copy">未发现未闭合八度线；仍需核对其他内容。</p>}<form className="meter-correction-form" onSubmit={e => { e.preventDefault(); requestMeterCorrection(); }}><h3>拍号校正</h3><p className="micro-copy">请按原谱填写，从所选小节开始生效，保留后续已有拍号变化。</p><div className="meter-fields"><label>起点小节<input type="number" aria-label="拍号起点小节" min={1} max={score?.measures.length || 1} step={1} value={meterMeasure} disabled={!score} onChange={e => { setMeterMeasure(Number(e.target.value)); setConfirmMeter(false); }} /></label><label>分子<input type="number" aria-label="拍号分子" min={1} max={32} step={1} value={meterBeats} disabled={!score} onChange={e => { setMeterBeats(Number(e.target.value)); setConfirmMeter(false); }} /></label><label>分母<select aria-label="拍号分母" value={meterBeatType} disabled={!score} onChange={e => { setMeterBeatType(Number(e.target.value)); setConfirmMeter(false); }}>{[1, 2, 4, 8, 16, 32, 64].map(value => <option value={value} key={value}>{value}</option>)}</select></label></div><button type="submit" className="button quiet full-width" disabled={!score}>校正拍号</button>{confirmMeter && <div className="scan-delete-confirm" role="group" aria-label="确认拍号校正"><p>仅修改拍号和小节边界，不会自动修复音符时值；后续原有拍号变化保留，可撤销。将从第 {meterMeasure} 小节改为 {meterBeats}/{meterBeatType}，应用到所有源声部。</p><button type="button" className="text-button" onClick={() => void correctMeter()}>确认校正拍号</button><button type="button" className="text-button" onClick={() => setConfirmMeter(false)}>取消</button></div>}</form></section><section className="inspector-section part-names"><h3>声部名称</h3>{score?.parts.filter(part => part.sourcePartId).map(part => <div className="part-name-editor" key={part.id}><div><span>{part.name}</span><button className="text-button" aria-label={`更改声部名称 ${part.name}`} onClick={() => beginPartRename(part.id)}>改名</button></div>{renamingPartId === part.id && <form onSubmit={event => { event.preventDefault(); void renamePart(); }}><label>声部名称<input value={partNameDraft} maxLength={120} onChange={event => setPartNameDraft(event.target.value)} /></label><button className="button quiet" type="submit">保存声部名称</button><button className="text-button" type="button" onClick={() => setRenamingPartId(null)}>取消</button></form>}</div>)}</section><section className="review-note-section"><h3>音符校正</h3><section className="inspector-section correction-section"><label className="field-label" htmlFor="note-select">第 {currentMeasureIndex + 1} 小节的音符</label><select id="note-select" value={selectedNoteId || ''} disabled={!score} onChange={e => selectNote(e.target.value)}><option value="">选择一个音符</option>{selectedNote && !visibleNotes.some(n => n.id === selectedNote.id) && <option value={selectedNote.id}>第 {selectedNote.measure} 小节 · {noteLabel(selectedNote)}</option>}{visibleNotes.map(note => <option value={note.id} key={note.id}>{noteLabel(note)}</option>)}</select>{selectedNote ? <div className="note-editor"><div className="note-original"><span>原音高</span><strong>{pitchName(selectedNote.midi)}</strong><small>时值 {selectedNote.duration} 拍 · MIDI {selectedNote.midi}</small></div><label className="field-label" htmlFor="correct-pitch">改为 <span>{pitchName(editPitch)}</span></label><select id="correct-pitch" value={editPitch} onChange={e => setEditPitch(Number(e.target.value))}>{Array.from({ length: 128 }, (_, midi) => <option key={midi} value={midi}>{pitchName(midi)} · MIDI {midi}</option>)}</select><button className="button ink full-width" onClick={() => void correctNote()} disabled={selectedNote.midi === editPitch}>应用音高校正</button></div> : <div className="note-placeholder"><Icon name="pen" size={24} /><span>从上方列表精确选择音符。<br />点击谱面可辅助定位。</span></div>}<button className="text-button undo-button" disabled={!undo.length} onClick={() => void undoCorrection()}><Icon name="undo" size={14} />撤销校正{undo.length ? ` · ${undo.length}` : ''}</button><p className="micro-copy">按原调校正，保留最近 12 次修改。暂不编辑节奏、连线或布局。</p></section></section><details className="practice-disclosure capability-settings"><summary>播放还原范围</summary><section className="inspector-section"><p className="inspector-copy">支持基础音高、时值与声部练习。各声部可选择不同音色同时演奏，默认明亮钢琴。不模拟原谱的真实人声演唱。</p><p className="micro-copy">复杂表达记号未完整还原，装饰音、奏法、渐强渐弱和踏板等以这份谱的播放提示为准。听起来流畅不代表识别无误。</p></section></details></details>
<details id="export-settings" className="practice-disclosure export-settings"><summary>导出乐谱与音频</summary><section className="inspector-section export-section"><div className="section-heading"><h2>把练习带走</h2><Icon name="download" size={17} /></div><label className="field-label" htmlFor="export-scope">音频与 MIDI 导出范围</label><select id="export-scope" className="export-scope-select" value={exportScope} disabled={!score || exporting} onChange={e => setExportScope(e.target.value === 'excerpt' ? 'excerpt' : 'full')}><option value="full">整首</option><option value="excerpt">所选小节</option></select><p className="micro-copy export-scope-description">{exportScope === 'excerpt' && score ? `第 ${loopStart} 至 ${loopEnd} 小节，演奏一次，不展开谱面反复。使用上方起止小节，无需开启循环。` : '整首使用当前谱面反复设置。'} MusicXML 始终为整首。</p><div className="export-buttons"><button disabled={!score || exporting} onClick={() => void exportScore('xml')}>MusicXML<span>整首乐谱</span></button><button disabled={!score || exporting} onClick={() => void exportScore('midi')}>MIDI<span>音符</span></button><button disabled={!score || exporting} onClick={() => void exportScore('wav')}>WAV<span>音频</span></button></div><p className="micro-copy">XML 保留校正、移调和反复记号。MIDI / WAV 使用当前速度、声部和所选音色，不含预备拍或节拍器。{exporting ? ' 正在生成文件…' : ''}</p></section></details>
</div>
      </aside>
    </div>
    {compactLayout && mobileToolsOpen && <div className="mobile-tools-backdrop" onClick={() => setMobileToolsOpen(false)} aria-hidden="true" />}
    {dragging && <div className="drop-overlay"><Icon name="upload" size={42} /><h2>放下这一页谱</h2><p>MusicXML / MXL / PDF / PNG / JPEG</p></div>}
    {showKeys && <div className="modal-backdrop" onClick={() => setShowKeys(false)}><section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="keys-title" className="shortcut-dialog" onClick={e => e.stopPropagation()} onKeyDown={e => { if (e.key === 'Escape') setShowKeys(false); }}><div className="section-heading"><h2 id="keys-title">手不离琴，也能练习</h2><button autoFocus className="icon-button" onClick={() => setShowKeys(false)} aria-label="关闭快捷键"><Icon name="close" /></button></div><dl><div><dt><kbd>Space</kbd></dt><dd>播放 / 暂停</dd></div><div><dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>上一 / 下一小节</dd></div><div><dt><kbd>Home</kbd></dt><dd>回到开头</dd></div><div><dt><kbd>M</kbd></dt><dd>节拍器开关</dd></div><div><dt><kbd>L</kbd></dt><dd>循环开关</dd></div><div><dt><kbd>?</kbd></dt><dd>查看快捷键</dd></div></dl><p>在输入框、选择框或按钮上操作时，不接管按键。</p><button className="button ink full-width" onClick={() => setShowKeys(false)}>回到乐谱</button></section></div>}
  </div>;
}
