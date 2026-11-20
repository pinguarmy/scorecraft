import type { CSSProperties, RefObject } from 'react';
import type { Score } from '../music';
import { TOOLS_PANEL_ID } from '../app/useMobileTools';
import type { ToolsSection } from '../app/useMobileTools';
import type { PracticePlayer } from '../app/usePracticePlayer';
import { useNumberField } from '../app/useNumberField';
import { Icon } from './Icon';

type Props = {
  /** 窄屏工具面板打开时设为 inert。 */
  inert: boolean;
  score: Score | null;
  playback: PracticePlayer;
  currentMeasureIndex: number;
  tempo: number;
  onTempoChange: (tempo: number) => void;
  practiceSummary: string;
  loop: boolean;
  onEndLoop: () => void;
  allPartsMuted: boolean;
  onHearAllParts: () => void;
  practiceTriggerRef: RefObject<HTMLButtonElement | null>;
  onOpenTools: (section: ToolsSection) => void;
  onSkipMeasure: (direction: number) => void;
};

/** 播放与进度：进度条、播放按钮、速度、当前练习摘要、预备拍和音色加载状态。 */
export function Transport(props: Props) {
  const { score, playback, currentMeasureIndex, tempo } = props;
  const { position, playing, audioState, audioMessage, countInRemaining, countInCancelled } = playback;
  const tempoField = useNumberField({ value: tempo, min: 30, max: 240, onCommit: props.onTempoChange, resetKey: score });
  return (
    <section className="transport" aria-label="播放控制" inert={props.inert ? true : undefined}>
      <div className="section-heading transport-heading">
        <h2>播放与进度</h2>
        <span className="eyebrow">PLAY</span>
      </div>
      <div className="transport-core">
        <div className="timeline">
          <label className="sr-only" htmlFor="score-position">
            播放位置
          </label>
          <input
            id="score-position"
            type="range"
            min="0"
            max={score?.totalBeats || 1}
            step="0.05"
            value={Math.min(position, score?.totalBeats || 1)}
            onChange={e => playback.seek(Number(e.target.value))}
            disabled={!score}
            style={
              {
                '--progress': `${score ? (position / Math.max(1, score.totalBeats)) * 100 : 0}%`,
              } as CSSProperties
            }
          />
          <div className="timeline-labels">
            <span>
              {score
                ? `小节 ${String(currentMeasureIndex + 1).padStart(2, '0')} / ${String(score.measures.length).padStart(2, '0')}`
                : '等待载入乐谱'}
            </span>
            <span>
              {countInRemaining !== null
                ? `预备拍 · 第 ${currentMeasureIndex + 1} 小节开始`
                : playing
                  ? '正在练习'
                  : '按空格开始'}
              <kbd>space</kbd>
            </span>
          </div>
        </div>
        <div className="transport-row">
          <div className="playback-buttons">
            <button
              className="icon-button"
              onClick={playback.stopAndRewind}
              disabled={!score}
              aria-label="停止并回到开头"
              title="停止并回到开头"
            >
              <Icon name="stop" size={17} />
            </button>
            <button
              className="icon-button"
              onClick={() => props.onSkipMeasure(-1)}
              disabled={!score}
              aria-label="上一小节"
              title="上一小节 ←"
            >
              <Icon name="back" />
            </button>
            <button
              className="play-button"
              onClick={() => void playback.togglePlay()}
              disabled={!score}
              aria-label={audioState === 'loading' ? '取消音色加载' : playing ? '暂停' : '播放'}
              title="空格 播放 / 暂停"
            >
              <Icon name={playing ? 'pause' : 'play'} size={23} />
            </button>
            <button
              className="icon-button"
              onClick={() => props.onSkipMeasure(1)}
              disabled={!score}
              aria-label="下一小节"
              title="下一小节 →"
            >
              <Icon name="forward" />
            </button>
          </div>
          <div className="tempo-control">
            <label htmlFor="tempo">速度</label>
            <div>
              <input
                id="tempo"
                type="number"
                min="30"
                max="240"
                step="1"
                {...tempoField.inputProps}
                aria-describedby={tempoField.error ? 'tempo-error' : undefined}
                disabled={!score}
              />
              <span>BPM</span>
            </div>
            <input
              aria-label="调整速度"
              type="range"
              min="30"
              max="240"
              value={tempo}
              onChange={e => props.onTempoChange(Number(e.target.value))}
              disabled={!score}
            />
          </div>
        </div>
        {tempoField.error && (
          <p id="tempo-error" className="field-error" role="alert">
            速度：{tempoField.error}
          </p>
        )}
      </div>
      <div className="dock-action-row">
        <div className="practice-state" role="status" aria-live="polite" aria-atomic="true" aria-label="当前练习状态">
          <span>{score ? props.practiceSummary : '载入乐谱后开始练习'}</span>
          {props.loop && (
            <button className="text-button" onClick={props.onEndLoop}>
              结束循环
            </button>
          )}
          {props.allPartsMuted && (
            <div className="practice-silent-warning">
              <span>全部声部已静音，播放将没有乐谱声音。</span>
              <button className="text-button" onClick={props.onHearAllParts}>
                恢复全部声部
              </button>
            </div>
          )}
        </div>
        {/* 两个按钮打开同一个“练习与工具”面板（窄屏下是模态对话框，打开后这里不可操作），
            分别停在“当前练习”和其下方的工具分区（声音、校对、导出）。 */}
        <div className="mobile-tools-actions">
          <button
            ref={props.practiceTriggerRef}
            className="mobile-tools-trigger"
            aria-haspopup="dialog"
            aria-controls={TOOLS_PANEL_ID}
            onClick={() => props.onOpenTools('practice')}
          >
            当前练习
          </button>
          <button
            className="mobile-tools-trigger"
            aria-haspopup="dialog"
            aria-controls={TOOLS_PANEL_ID}
            onClick={() => props.onOpenTools('tools')}
          >
            工具
          </button>
        </div>
      </div>
      <div
        className={`count-in-status ${countInRemaining !== null ? 'is-counting' : ''}`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {countInRemaining !== null
          ? `预备拍 · 还剩 ${countInRemaining} 拍。第 ${currentMeasureIndex + 1} 小节开始。`
          : countInCancelled
            ? '预备拍已取消，按播放重新开始。'
            : ''}
      </div>
      {audioState === 'loading' && (
        <div className="audio-status" role="status">
          正在加载本机音色…{' '}
          <button className="text-button" onClick={() => playback.player.current?.pause()}>
            取消加载
          </button>
        </div>
      )}
      {audioState === 'error' && (
        <div className="audio-status error" role="alert">
          {audioMessage || '所选音色加载失败，请按播放重试。不会替换为其他音色。'}
        </div>
      )}
    </section>
  );
}
