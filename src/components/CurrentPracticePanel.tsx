import type { Score } from '../music';
import { displayPartName } from '../music/part-labels';
import type { MeasureJump } from '../app/useMeasureJump';
import { useNumberField } from '../app/useNumberField';
import type { PracticeSettings } from '../app/usePracticeSettings';

type Props = {
  score: Score | null;
  practice: PracticeSettings;
  jump: MeasureJump;
  baseTempo: number;
  slowTempo: number;
  fullTempo: number;
  quickLoopLength: number;
  onPracticeCurrentSegment: () => void;
};

/** “当前练习”：快捷速度、选段循环、移调、节拍器与预备拍、声部开关、跳到小节。 */
export function CurrentPracticePanel({
  score,
  practice,
  jump,
  baseTempo,
  slowTempo,
  fullTempo,
  quickLoopLength,
  onPracticeCurrentSegment,
}: Props) {
  const { loop, loopStart, loopEnd, transpose, metronome, countIn, muted, solo, followRepeats } = practice;
  const measureCount = score?.measures.length || 1;
  const startField = useNumberField({
    value: loopStart,
    min: 1,
    max: measureCount,
    resetKey: score,
    onCommit: (next) => {
      practice.setLoopStart(next);
      practice.setLoopEnd((previous) => Math.max(previous, next));
    },
  });
  const endField = useNumberField({
    value: loopEnd,
    min: loopStart,
    max: measureCount,
    resetKey: score,
    onCommit: practice.setLoopEnd,
  });
  const loopError = startField.error
    ? `起始小节：${startField.error}`
    : endField.error
      ? `结束小节：${endField.error}`
      : '';
  return (
    <section id="current-practice" className="current-practice" aria-labelledby="current-practice-title" tabIndex={-1}>
      <div className="section-heading">
        <h2 id="current-practice-title">当前练习</h2>
        <span className="edition">选段 · 慢练</span>
      </div>
      <div className="tempo-presets">
        <span>基准速度 {baseTempo} BPM</span>
        <button
          className="button quiet"
          aria-label="放慢至基准速度75%"
          title={`${slowTempo} BPM`}
          disabled={!score}
          onClick={() => practice.setTempo(slowTempo)}
        >
          75%
        </button>
        <button
          className="button quiet"
          aria-label="恢复基准速度"
          title={`${fullTempo} BPM`}
          disabled={!score}
          onClick={() => practice.setTempo(fullTempo)}
        >
          100%
        </button>
        <small title="识别未提供速度时使用默认值，并非原稿核实速度。">按谱内基准速度调整。</small>
      </div>
      <div className="segment-settings">
        <section className="inspector-section">
          <button
            className="button quiet full-width quick-loop-button"
            disabled={!score}
            onClick={onPracticeCurrentSegment}
          >
            从当前小节练{quickLoopLength || 4}小节
          </button>
          <div className="loop-range">
            <label>
              起始小节
              <input
                type="number"
                aria-label="循环起始小节"
                min="1"
                max={measureCount}
                step="1"
                {...startField.inputProps}
                aria-describedby={startField.error ? 'loop-range-error' : undefined}
                disabled={!score}
              />
            </label>
            <span>至</span>
            <label>
              结束小节
              <input
                type="number"
                aria-label="循环结束小节"
                min={loopStart}
                max={measureCount}
                step="1"
                {...endField.inputProps}
                aria-describedby={endField.error ? 'loop-range-error' : undefined}
                disabled={!score}
              />
            </label>
          </div>
          {loopError && (
            <p id="loop-range-error" className="field-error" role="alert">
              {loopError}
            </p>
          )}
          <button
            className={`toggle-row ${loop ? 'enabled' : ''}`}
            disabled={!score}
            aria-pressed={loop}
            onClick={() => practice.setLoop((v) => !v)}
          >
            <span>循环这几小节</span>
            <span className="switch" />
          </button>
          {score?.playback?.expanded && (
            <>
              <button
                className={`toggle-row ${followRepeats ? 'enabled' : ''}`}
                aria-pressed={followRepeats}
                onClick={() => practice.setFollowRepeats((v) => !v)}
              >
                <span>按谱面反复</span>
                <span className="switch" />
              </button>
              <p className="micro-copy">手动小节循环优先。关闭循环后按反复设置播放。</p>
            </>
          )}
        </section>
      </div>
      <div className="transpose-settings">
        <section className="inspector-section">
          <div className="transpose-row">
            <label htmlFor="transpose">升调与降调</label>
            <div className="stepper">
              <button
                aria-label="降低半音"
                disabled={!score || transpose <= -12}
                onClick={() => practice.setTranspose((v) => v - 1)}
              >
                −
              </button>
              <output id="transpose">
                {transpose > 0 ? '+' : ''}
                {transpose}
                <small>半音</small>
              </output>
              <button
                aria-label="升高半音"
                disabled={!score || transpose >= 12}
                onClick={() => practice.setTranspose((v) => v + 1)}
              >
                ＋
              </button>
            </div>
          </div>
        </section>
      </div>
      <div className="practice-clicks">
        <button
          className={`metronome-button ${metronome ? 'selected' : ''}`}
          aria-pressed={metronome}
          disabled={!score}
          onClick={() => practice.setMetronome((v) => !v)}
          title="节拍器 M"
        >
          <span className="metronome-symbol">♩</span>
          <span>节拍器</span>
        </button>
        <div className="count-in-control">
          <button
            className={`toggle-row ${countIn ? 'enabled' : ''}`}
            aria-label="播放前预备一小节"
            aria-pressed={countIn}
            disabled={!score}
            onClick={() => practice.setCountIn((value) => !value)}
          >
            <span>播放前预备一小节</span>
            <span className="switch" />
          </button>
          <p className="micro-copy">按四分音符计拍。预备拍仅用于播放，不写入导出。</p>
        </div>
      </div>
      <section className="parts-section">
        <div className="section-heading">
          <h3>听哪些声部</h3>
          <button className="text-button" disabled={!score || (!solo && !muted.length)} onClick={practice.hearAllParts}>
            全部声部
          </button>
        </div>
        <div className="parts-list">
          {score ? (
            score.parts.map((part, index) => (
              <div className="part-row" key={part.id}>
                <span className="part-name" title={part.name}>
                  {displayPartName(part.name, index)}
                </span>
                <button
                  className={`part-button ${muted.includes(part.id) ? 'selected' : ''}`}
                  aria-label={`${muted.includes(part.id) ? '取消静音' : '静音'} ${part.name}`}
                  aria-pressed={muted.includes(part.id)}
                  onClick={() =>
                    practice.setMuted((items) =>
                      items.includes(part.id) ? items.filter((id) => id !== part.id) : [...items, part.id],
                    )
                  }
                >
                  {muted.includes(part.id) ? '已静音' : '静音'}
                </button>
                <button
                  className={`part-button solo ${solo === part.id ? 'selected' : ''}`}
                  aria-label={`独奏 ${part.name}`}
                  aria-pressed={solo === part.id}
                  onClick={() => practice.setSolo(solo === part.id ? null : part.id)}
                >
                  只听
                </button>
              </div>
            ))
          ) : (
            <p className="micro-copy">载入乐谱后选择声部。</p>
          )}
        </div>
      </section>
      <form
        className="measure-jump"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          jump.jumpToMeasure();
        }}
      >
        <label htmlFor="jump-measure">跳到小节</label>
        <input
          id="jump-measure"
          type="number"
          min={1}
          max={score?.measures.length || 1}
          step={1}
          value={jump.jumpMeasure}
          disabled={!score}
          aria-invalid={!!jump.jumpError}
          aria-describedby={jump.jumpError ? 'jump-measure-error' : undefined}
          onFocus={() => {
            jump.jumpFocused.current = true;
          }}
          onBlur={() => {
            jump.jumpFocused.current = false;
          }}
          onChange={(event) => jump.changeJumpMeasure(event.target.value)}
        />
        <button className="button quiet" disabled={!score} type="submit">
          跳转
        </button>
        {jump.jumpError && (
          <p id="jump-measure-error" role="alert">
            {jump.jumpError}
          </p>
        )}
      </form>
    </section>
  );
}
