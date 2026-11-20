import { lazy, Suspense } from 'react';
import type { RefObject } from 'react';
import type { Score } from '../music';
import type { LibrarySaveState } from '../practice/library';
import type { Notice, Original } from '../app/types';
import type { ScoreCorrections } from '../app/useScoreCorrections';
import { Icon } from './Icon';

const ScoreView = lazy(() => import('./ScoreView'));

type FollowMode = 'scroll' | 'page';

type Props = {
  /** 窄屏工具面板打开时设为 inert。 */
  inert: boolean;
  score: Score | null;
  source: string;
  renderXml: string;
  position: number;
  playing: boolean;
  tempo: number;
  transpose: number;
  currentMeasureIndex: number;
  followMode: FollowMode;
  onFollowModeChange: (mode: FollowMode) => void;
  followEnabled: boolean;
  onToggleFollow: () => void;
  metadata: ScoreCorrections['metadata'];
  saveState: LibrarySaveState | undefined;
  onRetrySave: (force: boolean) => void;
  /** 服务器报告的扫描原稿保留天数。 */
  scanRetention: number;
  onShowLibrary: () => void;
  notice: Notice;
  onDismissNotice: () => void;
  busy: string;
  onCancelWaiting: () => void;
  original: Original | null;
  originalRef: RefObject<HTMLDetailsElement | null>;
  onShowOriginal: () => void;
  onOpenReview: () => void;
  reviewWarningCount: number;
  selectedNoteId: string | null;
  onSelectNote: (id: string) => void;
  onSeek: (beat: number) => void;
  onChooseFile: () => void;
  onLoadDemo: () => void;
};

/** 中间的谱架：曲目信息、保存状态、跟谱方式、提示与进度、原稿预览和乐谱本身。 */
export function ScoreDesk(props: Props) {
  const { score, original } = props;
  return (
    <main id="score-desk" className="desk" tabIndex={-1} inert={props.inert ? true : undefined}>
      <div className="desk-topline">
        <span className="eyebrow">PRACTICE / 练习</span>
        <span>{score ? `${score.measures.length} 小节 · ${score.parts.length} 声部` : '一页谱，一个专注的下午'}</span>
      </div>
      <div className="score-heading">
        <div>
          <div className="score-source">{score ? props.source : '你的下一份乐谱'}</div>
          <h2>{score?.title || '让乐谱，响起来。'}</h2>
          <p>{score ? score.composer || '作曲者未注明' : '读谱、聆听、校正。在同一张桌上。'}</p>
          {score && (
            <button
              className="text-button edit-metadata-button"
              aria-expanded={props.metadata.editing}
              onClick={props.metadata.toggleEditor}
            >
              编辑曲名
            </button>
          )}
        </div>
        {score && (
          <button
            className="icon-button print-button"
            onClick={() => window.print()}
            aria-label="打印当前乐谱"
            title="打印当前乐谱"
          >
            <Icon name="print" />
          </button>
        )}
      </div>
      {score && (
        <SaveStatus
          score={score}
          saveState={props.saveState}
          onRetrySave={props.onRetrySave}
          scanRetention={props.scanRetention}
        />
      )}
      {score && (
        <div className="score-follow-controls">
          <button className="text-button return-library-button" onClick={props.onShowLibrary}>
            谱库与导入
          </button>
          <label htmlFor="follow-mode">跟谱方式</label>
          <select
            id="follow-mode"
            value={props.followMode}
            onChange={e => props.onFollowModeChange(e.target.value === 'page' ? 'page' : 'scroll')}
          >
            <option value="scroll">向下滚动</option>
            <option value="page">左右翻页</option>
          </select>
          <button
            className={`toggle-row ${props.followEnabled ? 'enabled' : ''}`}
            aria-label="自动跟谱"
            aria-pressed={props.followEnabled}
            onClick={props.onToggleFollow}
          >
            <span>自动跟谱</span>
            <span className="switch" />
          </button>
        </div>
      )}
      {score && props.metadata.editing && <MetadataForm metadata={props.metadata} />}
      {props.notice && (
        <div className={`notice ${props.notice.kind}`} role={props.notice.kind === 'error' ? 'alert' : 'status'}>
          <span>{props.notice.text}</span>
          <button className="icon-button" aria-label="关闭提示" onClick={props.onDismissNotice}>
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      {props.busy && (
        <div className="job-status" role="status">
          <span className="job-indicator" />
          <span>{props.busy}</span>
          <button className="text-button" onClick={props.onCancelWaiting}>
            停止等待
          </button>
        </div>
      )}
      {original && <OriginalPreview original={original} originalRef={props.originalRef} />}
      {score && (
        <div className="review-notice">
          <button className="text-button" onClick={props.onOpenReview}>
            校对与原稿{props.reviewWarningCount ? ` · ${props.reviewWarningCount} 项提示` : ''}
          </button>
          {original && (
            <button className="text-button" onClick={props.onShowOriginal}>
              查看原稿对照 ↗
            </button>
          )}
        </div>
      )}
      <div className={`score-paper ${score ? 'has-score' : ''}`}>
        <div className="paper-meta">
          <span>{score ? 'SCORE / 乐谱' : '空白谱架'}</span>
          <span>
            {score
              ? `${props.transpose ? `${props.transpose > 0 ? '+' : ''}${props.transpose} 半音` : '原调'} · ${props.tempo} BPM`
              : '准备好了，再开始'}
          </span>
        </div>
        {score ? (
          <Suspense
            fallback={
              <div className="score-render-message" role="status">
                正在加载乐谱排版引擎…
              </div>
            }
          >
            <ScoreView
              xml={props.renderXml}
              measures={score.measures}
              position={props.position}
              playing={props.playing}
              followMode={props.followMode}
              followEnabled={props.followEnabled}
              selectedNoteId={props.selectedNoteId}
              onSelectNote={props.onSelectNote}
              onSeek={props.onSeek}
            />
          </Suspense>
        ) : (
          <EmptyScore onChooseFile={props.onChooseFile} onLoadDemo={props.onLoadDemo} />
        )}
        <div className="paper-footer">
          <span>谱间 · ScoreCraft</span>
          <span>
            {score
              ? `第 ${props.currentMeasureIndex + 1} / ${score.measures.length} 小节`
              : 'YOUR PERSONAL PRACTICE DESK'}
          </span>
        </div>
      </div>
    </main>
  );
}

type SaveStatusProps = {
  score: Score;
  saveState: LibrarySaveState | undefined;
  onRetrySave: (force: boolean) => void;
  scanRetention: number;
};

/**
 * 本机谱库保存状态；失败或冲突时提供重试 / 覆盖保存。
 *
 * 没有保存状态（saveState 为 undefined）只出现在一种情况：本页还没保存过这份谱，
 * 而刚从谱库读出的内容和练习设置与谱库一致。这时保存器没有要写的内容，只在清理浏览器
 * 发件箱后才报告“已保存”；发件箱（IndexedDB）慢或被占用时会停在这里。其他打开方式
 * 都会在激活乐谱的同时报告“正在保存”。
 */
function SaveStatus({ score, saveState, onRetrySave, scanRetention }: SaveStatusProps) {
  return (
    <div className={`library-save-status ${saveState?.status || ''}`} role="status" aria-live="polite">
      <span>
        {saveState?.status === 'saved'
          ? '已保存到本机谱库'
          : saveState?.status === 'conflict'
            ? `保存冲突：${saveState.error || '已被其他窗口更新。'}`
            : saveState?.status === 'error'
              ? `保存失败：${saveState.error || '请检查本机服务。'}`
              : saveState?.status === 'saving'
                ? '正在保存…'
                : '与本机谱库中的版本一致'}
      </span>
      {(saveState?.status === 'error' || saveState?.status === 'conflict') && (
        <button className="text-button" onClick={() => onRetrySave(saveState?.status === 'conflict')}>
          {saveState?.status === 'conflict' ? '覆盖保存' : '重试保存'}
        </button>
      )}
      {saveState?.outboxError && <small className="outbox-warning">{saveState.outboxError}</small>}
      {score.xml.length > 350_000 && (
        <small>这份谱较大，不写入浏览器最近历史；请以本机谱库保存状态为准。原始扫描另按 {scanRetention} 天保留。</small>
      )}
    </div>
  );
}

/** 曲名与作者编辑表单。 */
function MetadataForm({ metadata }: { metadata: ScoreCorrections['metadata'] }) {
  return (
    <form
      className="metadata-form"
      onSubmit={e => {
        e.preventDefault();
        void metadata.save();
      }}
    >
      <label>
        曲名
        <input
          name="score-title"
          value={metadata.titleDraft}
          maxLength={200}
          onChange={e => metadata.setTitleDraft(e.target.value)}
        />
      </label>
      <label>
        作曲者
        <input
          name="score-composer"
          value={metadata.composerDraft}
          maxLength={200}
          onChange={e => metadata.setComposerDraft(e.target.value)}
        />
      </label>
      <div>
        <button className="button ink" type="submit">
          保存曲名与作者
        </button>
        <button className="text-button" type="button" onClick={() => metadata.setEditing(false)}>
          取消
        </button>
      </div>
    </form>
  );
}

type OriginalPreviewProps = { original: Original; originalRef: RefObject<HTMLDetailsElement | null> };

/** 可折叠的原稿预览（PDF 内嵌或图片）。 */
function OriginalPreview({ original, originalRef }: OriginalPreviewProps) {
  return (
    <details ref={originalRef} className="original-preview">
      <summary>
        查看原谱 <span>{original.name}</span>
      </summary>
      <div className="original-toolbar">
        <span>
          {original.jobId
            ? '原稿由本机扫描档案提供，删除或过期后不可读取。'
            : '仅在本页保留；识别完成后也可从扫描档案重开。'}
        </span>
        <a href={original.url} target="_blank" rel="noreferrer">
          在新标签打开原稿 ↗
        </a>
      </div>
      {original.pdf ? (
        <object data={original.url} type="application/pdf" aria-label={`原始 PDF：${original.name}`}>
          <p>浏览器无法内嵌 PDF。请使用上方链接打开原稿。</p>
        </object>
      ) : (
        <img src={original.url} alt={`上传的原始乐谱：${original.name}`} />
      )}
    </details>
  );
}

/** 尚未打开乐谱时的空谱架。 */
function EmptyScore({ onChooseFile, onLoadDemo }: { onChooseFile: () => void; onLoadDemo: () => void }) {
  return (
    <div className="empty-score">
      <div className="empty-staff" aria-hidden="true">
        <span>𝄞</span>
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
      <span className="eyebrow">THE FIRST NOTE IS YOURS</span>
      <h3>把这一页，放上谱架。</h3>
      <p>
        直接打开 MusicXML，或从纸谱开始识别。
        <br />
        还没有文件？听听我们的原创示例。
      </p>
      <div className="empty-actions">
        <button className="button ink" onClick={() => onChooseFile()}>
          <Icon name="upload" />
          选择乐谱
        </button>
        <button className="button quiet" onClick={() => onLoadDemo()}>
          打开 First Light <span>↗</span>
        </button>
      </div>
      <span className="empty-footnote">示例需要你手动打开，不会冒充扫描结果。</span>
    </div>
  );
}
