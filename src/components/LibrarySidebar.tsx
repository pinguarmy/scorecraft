import type { KeyboardEvent, RefObject } from 'react';
import type { Health, ScanJob } from '../api/scorecraft';
import { libraryItemStateLabels } from '../app/library-items';
import type { LibraryItem } from '../app/library-items';
import type { ScanJobsState } from '../app/useScanJobs';
import { Icon } from './Icon';
import { ScanArchive } from './ScanArchive';

type Props = {
  hasScore: boolean;
  expanded: boolean;
  onToggleExpanded: () => void;
  /** 窄屏工具面板打开时设为 inert。 */
  inert: boolean;
  importButtonRef: RefObject<HTMLButtonElement | null>;
  onChooseFile: () => void;
  documents: LibraryItem[];
  activeDocumentId: string | null;
  libraryError: string;
  sessionReady: boolean;
  onRefreshLibrary: () => void;
  onOpenDocument: (item: LibraryItem) => void;
  onLoadDemo: (repeatStudy?: boolean) => void;
  hasRecent: boolean;
  onClearHistory: () => void;
  scans: ScanJobsState;
  onOpenScan: (job: ScanJob) => void;
  onRetryWithoutCover: (job: ScanJob) => void;
  onDeleteScan: (job: ScanJob) => void;
  health: Health | null;
  healthError: boolean;
  onRefreshHealth: () => void;
};

/** 左侧“谱库与导入”：导入入口、我的乐谱、示例、谱库管理（扫描档案、识别服务、许可证）。 */
export function LibrarySidebar(props: Props) {
  const { hasScore, expanded, documents, activeDocumentId, scans } = props;
  const openOnKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      props.onChooseFile();
    }
  };

  return (
    <aside
      className={`library ${hasScore ? 'has-active-score' : ''} ${expanded ? 'expanded' : ''}`}
      aria-label="谱库与导入"
      inert={props.inert ? true : undefined}
    >
      <button className="mobile-library-toggle" aria-expanded={!hasScore || expanded} onClick={props.onToggleExpanded}>
        我的乐谱与导入 {expanded ? '−' : '＋'}
      </button>
      <div className="library-content">
        <div className="section-heading">
          <span className="eyebrow">YOUR MUSIC DESK</span>
          <span className="edition">01 / 谱库</span>
        </div>
        <h1>从一页谱开始</h1>
        <p className="library-intro">
          打开乐谱，听一遍。
          <br />
          把难的那一小节，慢慢练熟。
        </p>
        <button ref={props.importButtonRef} className="button primary import-button" onClick={props.onChooseFile}>
          <Icon name="upload" />
          导入乐谱<span>＋</span>
        </button>
        <p className="file-hint">
          MusicXML / MXL 直接打开
          <br />
          PDF / 图片交给本地 Audiveris
        </p>
        <div className="import-drop" role="button" tabIndex={0} onClick={props.onChooseFile} onKeyDown={openOnKey}>
          <Icon name="file" size={24} />
          <span>也可以把文件拖到这里</span>
          <small>每次导入一份乐谱</small>
        </div>
        <div className="library-rule" />
        <section className="my-library">
          <div className="section-heading">
            <h2>我的乐谱</h2>
            <span className="small-count">{documents.length}</span>
          </div>
          <button className="text-button" aria-label="刷新我的乐谱" onClick={props.onRefreshLibrary}>
            刷新乐谱 ↻
          </button>
          {props.libraryError && (
            <p className="scan-error" role="status">
              {props.libraryError}
            </p>
          )}
          <ul className="saved-document-list">
            {documents.map((item) => (
              <li key={item.id} data-document-id={item.id}>
                <button
                  className={activeDocumentId === item.id ? 'recent-item active' : 'recent-item'}
                  aria-label={`打开乐谱：${item.title}`}
                  onClick={() => props.onOpenDocument(item)}
                >
                  <Icon name="file" />
                  <span>
                    <strong>{item.title}</strong>
                    <small>
                      {libraryItemStateLabels[item.state]}
                      {item.jobId && scans.scanJobs.some((job) => job.id === item.jobId) ? ' · 含扫描档案' : ''}
                    </small>
                  </span>
                  {item.state === 'unsaved' && <span className="unsaved-badge">未保存</span>}
                </button>
              </li>
            ))}
          </ul>
          {!documents.length && (
            <p className="recent-empty">{props.sessionReady ? '打开的乐谱会统一留在这里。' : '正在恢复本机谱库…'}</p>
          )}
        </section>
        <button className="demo-link" onClick={() => props.onLoadDemo()}>
          <span className="demo-note">♫</span>
          <span>
            <strong>先试一页示例</strong>
            <small>First Light · 原创钢琴小品 / CC0</small>
          </span>
          <span>↗</span>
        </button>
        <button className="repeat-demo-link text-button" onClick={() => props.onLoadDemo(true)}>
          试试反复练习示例 ↗
        </button>
        <details className="library-management">
          <summary>谱库管理与导入帮助</summary>
          <p className="micro-copy">
            乐谱保存在本机谱库；扫描原稿另按 {scans.scanRetention} 天保留。最近缓存不是完整备份。
          </p>
          {props.hasRecent && (
            <button className="text-button clear-history" onClick={props.onClearHistory}>
              清除本地历史
            </button>
          )}
          <ScanArchive
            scans={scans}
            onOpenScan={props.onOpenScan}
            onRetryWithoutCover={props.onRetryWithoutCover}
            onDeleteScan={props.onDeleteScan}
          />
          <EnginePanel health={props.health} healthError={props.healthError} onRefresh={props.onRefreshHealth} />
          <div className="library-foot">
            不上传云端 · 无需账号
            <br />
            <span>LOCAL-FIRST, NOTE BY NOTE.</span>
          </div>
          <details className="about-panel">
            <summary>关于谱间 · AGPL-3.0 开源</summary>
            <p>ScoreCraft 以 AGPL-3.0-or-later 许可提供，不提供任何担保。识别和播放结果需要人工核对。</p>
            <p>
              <a href="/api/license" target="_blank" rel="noreferrer">
                阅读完整许可证 ↗
              </a>
              <br />
              <a href="/api/source" download>
                下载本实例源码
              </a>
            </p>
            <p>
              乐谱和练习设置自动保存在本机谱库，保存失败会提示重试。浏览器最近历史仅缓存 4 份、每份最多 35
              万字符，不是完整备份。清除最近历史不删除已保存的谱。扫描文件只交给本机 Audiveris，原始图片和 PDF
              由扫描档案另保留 {scans.scanRetention} 天。重新打开不会自动播放。
            </p>
          </details>
        </details>
      </div>
    </aside>
  );
}

type EnginePanelProps = { health: Health | null; healthError: boolean; onRefresh: () => void };

/** 本机 Audiveris 识别服务的状态与启用说明。 */
function EnginePanel({ health, healthError, onRefresh }: EnginePanelProps) {
  return (
    <div className="engine-panel">
      <div className="engine-heading">
        <span className={`status-dot ${health?.engine.available ? 'ready' : ''}`} />
        <strong>
          {health?.engine.available
            ? 'Audiveris 已就绪'
            : healthError
              ? '识别服务未连接'
              : health
                ? 'Audiveris 未安装'
                : '正在检查识别服务'}
        </strong>
        <button className="text-button" onClick={onRefresh} aria-label="重新检查识别服务">
          ↻
        </button>
      </div>
      <p>
        {health?.engine.available
          ? `图片与 PDF 在本机识别${health.engine.version ? ` · ${health.engine.version}` : ''}。识别后仍需人工核对。`
          : 'MusicXML 始终可用。扫描识别需要本地后端与 Audiveris，不会用示例代替结果。'}
      </p>
      {health && !health.engine.available && (
        <details>
          <summary>如何启用扫描识别</summary>
          <p>{health.engine.detail || '运行 npm run setup:omr，完成后重启本地服务。'}</p>
          <code>npm run setup:omr</code>
        </details>
      )}
    </div>
  );
}
