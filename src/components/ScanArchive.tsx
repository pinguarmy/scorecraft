import { useState } from 'react';
import type { ScanJob } from '../api/scorecraft';
import type { ScanJobsState } from '../app/useScanJobs';

const statusLabels: Record<ScanJob['status'], string> = {
  queued: '排队',
  running: '识别中',
  done: '已完成',
  error: '失败',
};

/** 失败原因像是“第一页没有五线谱”（多为封面）的 PDF，才提供跳过第 1 页重试。 */
const canRetryWithoutCover = (job: ScanJob) =>
  job.status === 'error' &&
  /\.pdf$/i.test(job.originalName || '') &&
  /(?:五线谱|staff|staves|regular\s*staff)/i.test(job.message || '');

type Props = {
  scans: ScanJobsState;
  onOpenScan: (job: ScanJob) => void;
  onRetryWithoutCover: (job: ScanJob) => void;
  onDeleteScan: (job: ScanJob) => void;
};

/** 谱库管理中的“扫描档案”：服务器保留的识别任务，可打开、重试或删除。 */
export function ScanArchive({ scans, onOpenScan, onRetryWithoutCover, onDeleteScan }: Props) {
  const { scanJobs, scanBusy, scanError, scanRetention, deleteJobId, setDeleteJobId, deletingJob, retryingJob } = scans;
  const [scanOpen, setScanOpen] = useState(false);

  return (
    <section className="scan-library" aria-label="本机扫描档案">
      <div className="section-heading">
        <button
          className="scan-heading"
          aria-label="扫描档案"
          aria-expanded={scanOpen}
          onClick={() => {
            setScanOpen(v => !v);
            if (!scanOpen) void scans.refreshScans();
          }}
        >
          扫描档案 <span>{scanOpen ? '−' : '＋'}</span>
        </button>
        <button
          className="text-button"
          onClick={() => void scans.refreshScans()}
          disabled={scanBusy}
          aria-label="刷新扫描档案"
        >
          ↻
        </button>
      </div>
      {scanOpen && (
        <div className="scan-library-body">
          <p className="micro-copy">本机服务器保留 {scanRetention} 天。删除扫描不会删除浏览器中的校正版。</p>
          {scanBusy && (
            <p role="status" className="micro-copy">
              正在读取扫描档案…
            </p>
          )}
          {scanError && (
            <p className="scan-error" role="alert">
              {scanError}
            </p>
          )}
          {!scanBusy && !scanJobs.length && !scanError && <p className="micro-copy">还没有扫描档案。</p>}
          <ul className="scan-list">
            {scanJobs.map(job => (
              <li key={job.id} data-job-id={job.id}>
                <div className="scan-item-heading">
                  <strong title={job.originalName || '历史扫描'}>{job.originalName || '历史扫描'}</strong>
                  <span className={`scan-status ${job.status}`}>{statusLabels[job.status]}</span>
                </div>
                <small>{new Date(job.createdAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}</small>
                {job.message && <p className="scan-message">{job.message}</p>}
                {canRetryWithoutCover(job) && (
                  <button
                    className="text-button retry-cover-button"
                    disabled={!!retryingJob}
                    onClick={() => onRetryWithoutCover(job)}
                  >
                    {retryingJob === job.id ? '正在跳过封面重试…' : '跳过第1页重试'}
                  </button>
                )}
                <div className="scan-actions">
                  <button
                    className="text-button"
                    disabled={job.status !== 'done'}
                    aria-label={`打开扫描：${job.originalName || '历史扫描'}`}
                    onClick={() => onOpenScan(job)}
                  >
                    打开乐谱与原稿 ↗
                  </button>
                  {(job.status === 'done' || job.status === 'error') && (
                    <button
                      className="text-button delete-scan"
                      aria-label={`删除扫描：${job.originalName || '历史扫描'}`}
                      onClick={() => setDeleteJobId(job.id)}
                    >
                      删除
                    </button>
                  )}
                </div>
                {deleteJobId === job.id && (
                  <div className="scan-delete-confirm">
                    <p>删除这次扫描的原稿和结果？浏览器校正版不受影响。</p>
                    <button
                      className="text-button delete-scan"
                      disabled={!!deletingJob}
                      onClick={() => onDeleteScan(job)}
                    >
                      {deletingJob === job.id ? '正在删除…' : '确认删除扫描'}
                    </button>
                    <button className="text-button" disabled={!!deletingJob} onClick={() => setDeleteJobId(null)}>
                      取消
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
