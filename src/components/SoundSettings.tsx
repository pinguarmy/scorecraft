import type { Score } from '../music';
import { DEFAULT_INSTRUMENT, INSTRUMENTS } from '../music/instruments';
import type { InstrumentId } from '../music/instruments';
import { ARRANGEMENTS } from '../music/arrangements';
import { displayPartName } from '../music/part-labels';
import type { InstrumentArrangement } from '../app/useInstrumentArrangement';

/** 配器预设在界面上的中文名（未列出的沿用预设自带的 label）。 */
const arrangementLabel = (item: (typeof ARRANGEMENTS)[number]) =>
  item.id === 'piano-bright'
    ? '全部明亮钢琴'
    : item.id === 'piano-warm'
      ? '全部温暖钢琴'
      : item.id === 'acoustic'
        ? '吉他与贝斯'
        : item.label;

type Props = {
  score: Score | null;
  partInstruments: Record<string, InstrumentId>;
  instruments: InstrumentArrangement;
  audioReady: boolean;
  onToggleShortcuts: () => void;
};

/** “声音”分区：整首配器、全部换成、逐个声部音色与音色提示。 */
export function SoundSettings({ score, partInstruments, instruments, audioReady, onToggleShortcuts }: Props) {
  const { showInstrumentDetails, instrumentWarnings } = instruments;
  return (
    <details id="sound-settings" className="practice-disclosure sound-settings">
      <summary>
        声音<small>配器与音色</small>
      </summary>
      <section className="inspector-section">
        <div className="arrangement-controls">
          <label htmlFor="arrangement-preset">整首配器</label>
          <select
            id="arrangement-preset"
            value={instruments.arrangementPreset}
            disabled={!score}
            onChange={e => instruments.applyArrangement(e.target.value)}
          >
            <option value="none">当前配器</option>
            {ARRANGEMENTS.map(item => (
              <option key={item.id} value={item.id}>
                {arrangementLabel(item)}
              </option>
            ))}
          </select>
          <label htmlFor="all-parts-instrument">全部换成</label>
          <select
            id="all-parts-instrument"
            value=""
            disabled={!score}
            onChange={e => instruments.applyAllInstruments(e.target.value)}
          >
            <option value="" disabled>
              选择后应用到全部声部
            </option>
            {INSTRUMENTS.map(instrument => (
              <option
                key={instrument.id}
                value={instrument.id}
                disabled={
                  instrument.id === 'drums' &&
                  (!score ||
                    score.parts.some(
                      part => !part.notes.length || !part.notes.every(note => note.percussion !== undefined),
                    ))
                }
              >
                {instrument.label}
              </option>
            ))}
          </select>
          <p className="micro-copy">
            选择即应用整首；组合是练习配器，不是对原谱乐器的识别。真实打击乐声部按组合保留鼓组。
          </p>
          <button
            className="text-button instrument-details-toggle"
            aria-expanded={showInstrumentDetails}
            aria-controls="individual-instrument-controls"
            onClick={() => instruments.setShowInstrumentDetails(value => !value)}
          >
            逐个调整音色 {showInstrumentDetails ? '−' : '＋'}
          </button>
        </div>
        <div id="individual-instrument-controls" hidden={!showInstrumentDetails}>
          {score?.parts.map((part, index) => (
            <label className="part-instrument-field" key={part.id}>
              <span>{displayPartName(part.name, index)}</span>
              <select
                aria-label={`声部乐器 ${part.name}`}
                value={partInstruments[part.id] || DEFAULT_INSTRUMENT}
                onChange={event => instruments.changePartInstrument(part.id, event.target.value)}
              >
                {INSTRUMENTS.map(instrument => (
                  <option
                    key={instrument.id}
                    value={instrument.id}
                    disabled={instrument.id === 'drums' && !part.notes.some(note => note.percussion !== undefined)}
                  >
                    {instrument.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        {instrumentWarnings.length > 0 && (
          <div className="instrument-warnings" role="status">
            {instrumentWarnings.map((warning, index) => (
              <p key={index}>{warning}</p>
            ))}
          </div>
        )}
        <p className="micro-copy">钢琴、吉他、贝斯和小提琴使用本机录音；铺底与电子鼓为合成音。</p>
        <div className="transport-note">
          <span className={`status-dot ${audioReady ? 'ready' : ''}`} />
          <a href="/audio/piano/README.md" target="_blank" rel="noreferrer">
            真实钢琴录音采样 · Salamander / Yamaha C5
          </a>
          <span className="keyboard-link">
            <button className="text-button" onClick={onToggleShortcuts}>
              键盘快捷键 ↗
            </button>
          </span>
        </div>
      </section>
    </details>
  );
}
