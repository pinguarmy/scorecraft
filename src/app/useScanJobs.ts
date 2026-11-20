import { useCallback, useRef, useState } from 'react';
import { ApiError, deleteScanJob, listScanJobs, validJobId } from '../api/scorecraft';
import type { ScanJob } from '../api/scorecraft';

/**
 * 服务器上的扫描档案列表，以及删除 / 重试时的按钮状态。
 * 首次加载由 App 的挂载 effect 触发（与谱库恢复一起），这里不自带 effect。
 */
export function useScanJobs() {
  const [scanJobs, setScanJobs] = useState<ScanJob[]>([]);
  const [scanBusy, setScanBusy] = useState(false);
  const [scanError, setScanError] = useState('');
  const [scanRetention, setScanRetention] = useState(7);
  const [deleteJobId, setDeleteJobId] = useState<string | null>(null);
  const [deletingJob, setDeletingJob] = useState<string | null>(null);
  const [retryingJob, setRetryingJob] = useState<string | null>(null);
  // 本页删除过的任务：之后即使有迟到的请求，也不再恢复它们的原稿。
  const deletedJobs = useRef(new Set<string>());

  const refreshScans = useCallback(async () => {
    setScanBusy(true);
    setScanError('');
    try {
      const data = await listScanJobs();
      setScanJobs(data.jobs);
      setScanRetention(data.retentionDays);
    } catch (e) {
      setScanError(e instanceof Error ? e.message : '无法获取扫描档案。');
    } finally {
      setScanBusy(false);
    }
  }, []);

  /** 删除扫描结果与原稿；成功后调用 onDeleted（App 用它清理原稿预览并提示）。 */
  async function deleteScan(job: ScanJob, onDeleted: (jobId: string) => void) {
    if (!validJobId(job.id)) return;
    setDeletingJob(job.id);
    setScanError('');
    try {
      await deleteScanJob(job.id);
      deletedJobs.current.add(job.id);
      setScanJobs(jobs => jobs.filter(item => item.id !== job.id));
      setDeleteJobId(null);
      onDeleted(job.id);
    } catch (e) {
      const message =
        e instanceof ApiError && e.status === 409
          ? `${e.message} 请稍后刷新再重试。`
          : e instanceof Error
            ? e.message
            : String(e);
      setScanError(`删除失败：${message}`);
    } finally {
      setDeletingJob(null);
    }
  }

  return {
    scanJobs,
    scanBusy,
    scanError,
    scanRetention,
    deleteJobId,
    setDeleteJobId,
    deletingJob,
    retryingJob,
    setRetryingJob,
    deletedJobs,
    refreshScans,
    deleteScan,
  };
}

export type ScanJobsState = ReturnType<typeof useScanJobs>;
