// 本地服务器接口的类型化客户端。
// App 之前在各处直接调用 fetch；这里集中路径、返回类型和错误信息的读取方式。
// 错误文案与调用方原有逻辑保持一致，便于界面层直接展示。

export type Health = {
  ok: boolean;
  engine: { available: boolean; name: string; version?: string; detail?: string };
  limits: { maxUploadBytes: number };
};

export type ScanResult = {
  id: string;
  status: string;
  message?: string;
  warnings?: string[];
  resultUrl?: string;
  skippedPages?: number[];
};

export type ScanJob = {
  id: string;
  status: 'queued' | 'running' | 'done' | 'error';
  createdAt: number | string;
  originalName?: string;
  message?: string;
  originalUrl?: string;
  resultUrl?: string;
};

export type QueuedRecognition = { id: string; reused?: boolean };

export type ScanJobList = { jobs: ScanJob[]; retentionDays: number };

/** 识别任务编号必须是 UUID；其他值不拼进请求路径。 */
export const validJobId = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

/** 从失败响应中读取服务器给出的说明；读不到时回退为带状态码的通用文案。 */
export async function responseError(response: Response) {
  try {
    const body = await response.json();
    return typeof body.error === 'string'
      ? body.error
      : typeof body.message === 'string'
        ? body.message
        : `请求失败，HTTP ${response.status}`;
  } catch {
    return `请求失败，HTTP ${response.status}`;
  }
}

/** 带 HTTP 状态码的请求错误，message 为 responseError 读取到的说明。 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function failed(response: Response) {
  return new ApiError(await responseError(response), response.status);
}

const jobPath = (id: string) => `/api/jobs/${encodeURIComponent(id)}`;

/** 原稿地址；可直接用作 <object>/<img> 的来源。 */
export const jobOriginalUrl = (id: string) => `${jobPath(id)}/original`;

/** GET /api/health。响应不完整时抛错（错误信息不展示给用户）。 */
export async function fetchHealth(): Promise<Health> {
  const res = await fetch('/api/health');
  if (!res.ok) throw new Error();
  const data = (await res.json()) as Health;
  if (!data.engine || !data.limits) throw new Error();
  return data;
}

/** GET /api/jobs。只保留编号有效的前 100 项；保留天数无效时按 7 天。 */
export async function listScanJobs(): Promise<ScanJobList> {
  const res = await fetch('/api/jobs');
  if (!res.ok) throw await failed(res);
  const data = (await res.json()) as ScanJobList;
  if (!Array.isArray(data.jobs)) throw new Error('扫描列表格式无效。');
  return {
    jobs: data.jobs.filter(job => typeof job.id === 'string' && validJobId(job.id)).slice(0, 100),
    retentionDays: Number.isFinite(data.retentionDays) ? data.retentionDays : 7,
  };
}

/** GET /api/jobs/:id。失败时抛出 ApiError。 */
export async function getScanJob(id: string, signal?: AbortSignal): Promise<ScanResult> {
  const response = await fetch(jobPath(id), { signal });
  if (!response.ok) throw await failed(response);
  return (await response.json()) as ScanResult;
}

/** GET /api/jobs/:id，但任何失败都返回 null（仅用于补充识别提示）。 */
export function getScanJobIfAvailable(id: string, signal?: AbortSignal): Promise<ScanResult | null> {
  return fetch(jobPath(id), { signal })
    .then(response => (response.ok ? (response.json() as Promise<ScanResult>) : null))
    .catch(() => null);
}

/** DELETE /api/jobs/:id。失败时抛出 ApiError，调用方可按 status 补充说明。 */
export async function deleteScanJob(id: string): Promise<void> {
  const res = await fetch(jobPath(id), { method: 'DELETE' });
  if (!res.ok) throw await failed(res);
}

export type JobScore = { data: ArrayBuffer; contentType: string };

/** GET /api/jobs/:id/score，返回识别结果的原始字节与内容类型。 */
export async function fetchJobScore(id: string, signal?: AbortSignal): Promise<JobScore> {
  const response = await fetch(`${jobPath(id)}/score`, { signal });
  if (!response.ok) throw await failed(response);
  const contentType = response.headers.get('content-type') || '';
  return { data: await response.arrayBuffer(), contentType };
}

export type OriginalProbe = { ok: false } | { ok: true; contentType: string };

/**
 * GET /api/jobs/:id/original，只确认原稿可读并读取内容类型，随后取消正文下载。
 * 网络错误或中止会照常抛出。
 */
export async function probeJobOriginal(id: string, signal?: AbortSignal): Promise<OriginalProbe> {
  const res = await fetch(jobOriginalUrl(id), { signal });
  if (!res.ok) return { ok: false };
  const contentType = res.headers.get('content-type') || '';
  await res.body?.cancel();
  return { ok: true, contentType };
}

/** POST /api/jobs/:id/retry，跳过第一页（封面）重新识别。 */
export async function retryScanJobWithoutCover(id: string, signal?: AbortSignal): Promise<ScanResult> {
  const response = await fetch(`${jobPath(id)}/retry`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ skipFirstPage: true }),
    signal,
  });
  if (!response.ok) throw await failed(response);
  return (await response.json()) as ScanResult;
}

/** POST /api/recognize，提交扫描文件给本机 Audiveris。 */
export async function submitRecognition(file: File, signal?: AbortSignal): Promise<QueuedRecognition> {
  const body = new FormData();
  body.append('file', file);
  const response = await fetch('/api/recognize', { method: 'POST', body, signal });
  if (!response.ok) throw await failed(response);
  return (await response.json()) as QueuedRecognition;
}
