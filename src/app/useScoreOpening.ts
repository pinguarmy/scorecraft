import type { Dispatch, RefObject, SetStateAction } from 'react';
import { readScore } from '../music';
import type { Score } from '../music';
import { documentId, sanitizeSession } from '../practice/session';
import type { RecentDocument } from '../practice/session';
import { getSavedDocument } from '../practice/library';
import type { RemoteSavedDocument } from '../practice/library';
import {
  fetchJobScore,
  getScanJob,
  getScanJobIfAvailable,
  jobOriginalUrl,
  probeJobOriginal,
  retryScanJobWithoutCover,
  submitRecognition,
  validJobId,
} from '../api/scorecraft';
import type { Health, ScanJob, ScanResult } from '../api/scorecraft';
import { scoreBounds } from './score-helpers';
import type { DocumentLibrary } from './useDocumentLibrary';
import type { ScanJobsState } from './useScanJobs';
import type { ToolsSection } from './useMobileTools';
import type { ActiveDocument, Original, SetNotice } from './types';

export type ActivateDocument = (
  next: Score,
  from: string,
  id: string,
  jobId?: string,
  preserve?: boolean,
  restoredSession?: unknown,
  openedAt?: number,
) => void;

type Options = {
  /** 当前打开请求；新的打开流程会中止上一个。 */
  request: RefObject<AbortController | null>;
  /** 每次打开流程递增；异步步骤完成后若编号已变，就不再更新界面。 */
  generation: RefObject<number>;
  activeRef: RefObject<ActiveDocument | null>;
  reviewRef: RefObject<HTMLDetailsElement | null>;
  library: DocumentLibrary;
  scans: ScanJobsState;
  health: Health | null;
  saveCurrent: () => void;
  activate: ActivateDocument;
  openTools: (section?: ToolsSection) => void;
  setBusy: (busy: string) => void;
  setNotice: SetNotice;
  setOriginal: Dispatch<SetStateAction<Original | null>>;
  setRecognitionWarnings: (warnings: string[]) => void;
};

/**
 * 从五个来源打开乐谱：示例、本地文件（MusicXML 直接打开，图片/PDF 交给本机识别）、
 * 本机谱库、浏览器最近历史、服务器扫描档案；以及“跳过第 1 页重试”。
 *
 * 所有流程共用 request / generation：开始时中止上一个请求并取得新编号，
 * 每个 await 之后用编号判断自己是否仍是最新的流程。
 */
export function useScoreOpening({
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
}: Options) {
  const { ensureDocuments, librarySaver, libraryStates, recentRef, findPendingSnapshot } = library;
  const { refreshScans, deletedJobs, setRetryingJob } = scans;

  /** 中止上一个打开流程，返回本次流程的控制器和编号。 */
  function beginRequest() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    const token = ++generation.current;
    return { controller, token };
  }

  /** “停止等待”：浏览器不再等待，已提交的识别任务仍在服务器上运行。 */
  function cancelWaiting() {
    request.current?.abort();
    generation.current++;
    setBusy('');
    setNotice({ kind: 'info', text: '已停止浏览器等待。已提交的本地识别任务可能仍在后台运行。' });
  }

  /**
   * 解析并打开一份 MusicXML。若这份谱（按文档编号）已有本页未保存的更改或谱库中的校正版，
   * 打开那个版本而不是传入的原始内容。谱库读取失败时拒绝打开，以免之后覆盖校正版。
   */
  async function openXml(
    input: string | ArrayBuffer,
    filename: string,
    from: string,
    token: number,
    explicitId?: string,
    jobId?: string,
  ) {
    await ensureDocuments();
    const parsed = await readScore(input, filename);
    const id = await documentId(parsed.xml, explicitId);
    let remote: RemoteSavedDocument | null = null;
    saveCurrent();
    await librarySaver.current?.flush();
    const pending = await findPendingSnapshot(id);
    try {
      if (!pending) {
        remote = await getSavedDocument(id);
        if (remote && typeof remote.updatedAt === 'number') {
          librarySaver.current?.setKnownVersion(id, remote.updatedAt);
        }
        libraryStates.current.delete(id);
      }
    } catch (error) {
      // An unread saved correction is not a failed write. Do not activate an
      // older import/cache and then offer to overwrite the unread version.
      throw new Error(
        `本机谱库读取失败，未打开这份谱，以免覆盖已保存的校正版。请检查本机服务后重新打开。${error instanceof Error ? error.message : ''}`,
      );
    }
    const saved = pending ?? remote ?? recentRef.current.find(item => item.id === id);
    const next = saved && saved.xml !== parsed.xml ? await readScore(saved.xml, 'saved.musicxml') : parsed;
    if (generation.current !== token) return;
    if (!pending && remote) {
      librarySaver.current?.setSaved(
        {
          id,
          title: next.title,
          composer: next.composer,
          source: remote.source,
          xml: remote.xml,
          opened: remote.opened,
          session: sanitizeSession(remote.session, scoreBounds(next)),
          ...(remote.jobId ? { jobId: remote.jobId } : {}),
        },
        typeof remote.updatedAt === 'number' ? remote.updatedAt : undefined,
      );
    }
    activate(next, saved?.source || from, id, saved?.jobId || jobId, false, saved?.session, saved?.opened);
    setOriginal(null);
  }

  async function loadDemo(repeatStudy = false) {
    const { controller, token } = beginRequest();
    setBusy('正在打开原创示例…');
    setNotice(null);
    try {
      const filename = repeatStudy ? 'repeat-study.musicxml' : 'first-light.musicxml';
      const res = await fetch(`/samples/${filename}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`示例暂不可用，HTTP ${res.status}`);
      await openXml(await res.text(), filename, repeatStudy ? '反复练习示例 · CC0' : '原创示例 · CC0', token);
      if (generation.current === token) setOriginal(null);
    } catch (e) {
      if (!controller.signal.aborted)
        setNotice({ kind: 'error', text: e instanceof Error ? e.message : '示例载入失败' });
    } finally {
      if (generation.current === token) setBusy('');
    }
  }

  /** 每 1.2 秒查询一次识别任务，最多等待 10 分钟；排队/识别中的进度写进 busy 文案。 */
  async function waitForJob(id: string, controller: AbortController, token: number): Promise<ScanResult> {
    const started = Date.now();
    while (!controller.signal.aborted && generation.current === token) {
      if (Date.now() - started > 10 * 60 * 1000)
        throw new Error('已等待 10 分钟。浏览器停止等待，请检查本地识别服务。');
      const job = await getScanJob(id, controller.signal);
      if (job.status === 'error')
        throw new Error(job.message || 'Audiveris 未能识别这份文件。请尝试清晰、平整的谱页。');
      if (job.status === 'done') return job;
      setBusy(
        job.status === 'queued'
          ? '识别任务排队中，请稍候…'
          : `Audiveris 正在识别${job.message ? `：${job.message}` : '，复杂谱页可能需要几分钟…'}`,
      );
      await new Promise<void>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          controller.signal.removeEventListener('abort', abort);
          resolve();
        }, 1200);
        const abort = () => {
          window.clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        };
        controller.signal.addEventListener('abort', abort, { once: true });
      });
    }
    throw new DOMException('Aborted', 'AbortError');
  }

  async function loadRecognizedJob(
    id: string,
    job: ScanResult,
    name: string,
    controller: AbortController,
    token: number,
  ) {
    const { data, contentType } = await fetchJobScore(id, controller.signal);
    const filename =
      /mxl/i.test(contentType) || /\.mxl(?:$|\?)/i.test(job.resultUrl || '') ? 'recognized.mxl' : 'recognized.musicxml';
    await openXml(data, filename, `本地识别 · ${name}`, token, `job:${id}`, id);
  }

  /** 识别结果载入后：显示原稿、展开识谱校对并提示核对。 */
  function showRecognitionResult(original: Original, warnings: string[] | undefined, text: string) {
    setOriginal(original);
    if (reviewRef.current) reviewRef.current.open = true;
    openTools('review');
    setRecognitionWarnings(warnings ?? []);
    setNotice({ kind: 'info', text });
  }

  async function importFile(file: File) {
    const { controller, token } = beginRequest();
    setNotice(null);
    setBusy(`正在读取 ${file.name}…`);
    try {
      if (/\.(musicxml|xml|mxl)$/i.test(file.name)) {
        if (file.size > 20 * 1024 * 1024) throw new Error('MusicXML 文件上限为 20 MB。请先拆分乐谱。');
        await openXml(await file.arrayBuffer(), file.name, file.name, token);
        if (generation.current === token) setOriginal(null);
        return;
      }
      if (!/\.(pdf|png|jpe?g)$/i.test(file.name)) throw new Error('请选择 MusicXML、MXL、PDF、PNG 或 JPEG 文件。');
      if (health && file.size > health.limits.maxUploadBytes) {
        throw new Error(`文件超过后端上限 ${Math.round(health.limits.maxUploadBytes / 1024 / 1024)} MB。`);
      }
      if (health && !health.engine.available) {
        throw new Error(
          `本地 Audiveris 尚未就绪。${health.engine.detail || '请在终端执行 npm run setup:omr，然后重新启动服务。'} MusicXML 文件仍可直接导入。`,
        );
      }
      setBusy('正在提交本地 Audiveris 识别…');
      const queued = await submitRecognition(file, controller.signal);
      if (!queued.id || !validJobId(queued.id)) throw new Error('识别服务未返回有效任务编号。');
      if (queued.reused) setBusy('找到同一份扫描，正在恢复已有结果…');
      const job = await waitForJob(queued.id, controller, token);
      await loadRecognizedJob(queued.id, job, file.name, controller, token);
      void refreshScans();
      if (generation.current === token) {
        showRecognitionResult(
          { url: URL.createObjectURL(file), name: file.name, pdf: /\.pdf$/i.test(file.name), jobId: queued.id },
          job.warnings,
          '识别结果已载入。请在识谱校对中对照原稿检查音高、节奏与声部。',
        );
      }
    } catch (e) {
      if (!controller.signal.aborted && generation.current === token) {
        setNotice({ kind: 'error', text: e instanceof Error ? e.message : '导入失败，请重试。' });
      }
    } finally {
      if (generation.current === token) setBusy('');
    }
  }

  /** 扫描 PDF 因封面识别失败时，跳过第 1 页创建新任务；原 PDF 与失败档案保留。 */
  async function retryWithoutCover(job: ScanJob) {
    if (!validJobId(job.id) || job.status !== 'error' || !/\.pdf$/i.test(job.originalName || '')) return;
    const { controller, token } = beginRequest();
    setRetryingJob(job.id);
    setBusy('原 PDF 不改，正在识别第 2 页起…');
    setNotice({
      kind: 'info',
      text: '将跳过第 1 页封面，创建新的识别任务。原 PDF 和失败档案均保留，不保证后续页一定识别成功。',
    });
    try {
      const queued = await retryScanJobWithoutCover(job.id, controller.signal);
      if (!validJobId(queued.id)) throw new Error('重试服务未返回有效任务编号。');
      void refreshScans();
      const completed = await waitForJob(queued.id, controller, token);
      await loadRecognizedJob(
        queued.id,
        completed,
        `${job.originalName || '扫描 PDF'} · 已跳过第 1 页`,
        controller,
        token,
      );
      if (generation.current === token) {
        showRecognitionResult(
          { url: jobOriginalUrl(queued.id), name: job.originalName || '原始 PDF', pdf: true, jobId: queued.id },
          completed.warnings,
          '已载入从第 2 页开始的识别结果。完整原 PDF 保留，请在识谱校对中检查原稿。',
        );
      }
    } catch (e) {
      if (!controller.signal.aborted && generation.current === token) {
        setNotice({ kind: 'error', text: `跳过封面重试失败：${e instanceof Error ? e.message : String(e)}` });
      }
    } finally {
      if (generation.current === token) setBusy('');
      setRetryingJob(null);
      void refreshScans();
    }
  }

  /** 从本机谱库打开；本页或发件箱中有未保存的更改时优先打开那个版本。 */
  async function openSavedDocument(id: string) {
    saveCurrent();
    const { controller, token } = beginRequest();
    setBusy('正在打开已保存的谱…');
    setNotice(null);
    try {
      await ensureDocuments();
      await librarySaver.current?.flush();
      const pending = await findPendingSnapshot(id);
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
          {
            id,
            title: parsed.title,
            composer: parsed.composer,
            source: saved.source,
            xml: saved.xml,
            opened: saved.opened,
            session: sanitizeSession(saved.session, scoreBounds(parsed)),
            ...(saved.jobId ? { jobId: saved.jobId } : {}),
          },
          typeof (saved as RemoteSavedDocument).updatedAt === 'number'
            ? (saved as RemoteSavedDocument).updatedAt
            : undefined,
        );
      }
      activate(parsed, saved.source, saved.id, saved.jobId, false, saved.session, saved.opened);
      setOriginal(null);
      if (saved.jobId) await restoreOriginal(saved.jobId, saved.source, token, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted && generation.current === token) {
        setNotice({ kind: 'error', text: error instanceof Error ? error.message : '已存乐谱打开失败。' });
      }
    } finally {
      if (generation.current === token) setBusy('');
    }
  }

  /** 从浏览器最近历史打开。 */
  async function openRecent(item: RecentDocument) {
    const { controller, token } = beginRequest();
    setNotice(null);
    setBusy('正在恢复本地乐谱…');
    try {
      await openXml(item.xml, 'recent.musicxml', item.source, token, item.id, item.jobId);
      if (item.jobId) await restoreOriginal(item.jobId, item.source, token, controller.signal);
    } catch (e) {
      if (!controller.signal.aborted && generation.current === token) {
        setNotice({ kind: 'error', text: `无法恢复乐谱：${e instanceof Error ? e.message : String(e)}` });
      }
    } finally {
      if (generation.current === token) setBusy('');
    }
  }

  /**
   * 为已打开的识别结果找回原稿（服务器扫描档案）和识别提示。
   * 原稿已删除、过期或类型不受支持时只提示，不影响练习。
   */
  async function restoreOriginal(jobId: string, name: string, token: number, signal: AbortSignal) {
    if (!validJobId(jobId) || deletedJobs.current.has(jobId)) return;
    const url = jobOriginalUrl(jobId);
    try {
      const probe = await probeJobOriginal(jobId, signal);
      if (!probe.ok) {
        if (generation.current === token) {
          setNotice({
            kind: 'info',
            text: '乐谱已打开，但原稿已删除、过期或不可读取。已保存的校正版仍可练习和导出。',
          });
        }
        return;
      }
      const mime = probe.contentType;
      const metadata = await getScanJobIfAvailable(jobId, signal);
      if (generation.current === token && metadata?.warnings) setRecognitionWarnings(metadata.warnings);
      if (!/^image\/(png|jpeg)/i.test(mime) && !/^application\/pdf/i.test(mime)) return;
      if (generation.current === token && !deletedJobs.current.has(jobId)) {
        setOriginal({ url, name, pdf: /^application\/pdf/i.test(mime), jobId });
      }
    } catch (e) {
      if (!signal.aborted && generation.current === token) {
        setNotice({
          kind: 'info',
          text: `乐谱已打开，原稿暂时不可读取：${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
  }

  /**
   * 打开一次扫描：谱库中已有对应校正版时打开校正版，其次是浏览器历史中的校正版，
   * 最后才读取服务器上的原始识别结果。打开后展开识谱校对。
   */
  async function openScan(job: ScanJob) {
    if (!validJobId(job.id) || job.status !== 'done') return;
    await ensureDocuments();
    if (library.savedDocuments.some(item => item.id === `job:${job.id}`)) {
      await openSavedDocument(`job:${job.id}`);
      if (activeRef.current?.id === `job:${job.id}`) openTools('review');
      return;
    }
    const corrected = recentRef.current.find(item => item.jobId === job.id);
    if (corrected) {
      await openRecent(corrected);
      if (activeRef.current?.id === corrected.id) openTools('review');
      return;
    }
    const { controller, token } = beginRequest();
    setBusy('正在打开扫描档案…');
    setNotice(null);
    try {
      const { data } = await fetchJobScore(job.id, controller.signal);
      await openXml(
        data,
        'scan.musicxml',
        `本地识别 · ${job.originalName || '历史扫描'}`,
        token,
        `job:${job.id}`,
        job.id,
      );
      await restoreOriginal(job.id, job.originalName || '历史扫描', token, controller.signal);
      if (generation.current === token) openTools('review');
    } catch (e) {
      if (!controller.signal.aborted && generation.current === token) {
        setNotice({ kind: 'error', text: `扫描档案打开失败：${e instanceof Error ? e.message : String(e)}` });
      }
    } finally {
      if (generation.current === token) setBusy('');
    }
  }

  return { loadDemo, importFile, retryWithoutCover, openSavedDocument, openRecent, openScan, cancelWaiting };
}

export type ScoreOpening = ReturnType<typeof useScoreOpening>;
