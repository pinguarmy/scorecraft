import type { RefObject } from 'react';
import type { Score } from '../music';
import { noteLabel, pitchName } from '../app/score-helpers';
import type { Original } from '../app/types';
import type { ScoreCorrections } from '../app/useScoreCorrections';
import { Icon } from './Icon';

const beatTypes = [1, 2, 4, 8, 16, 32, 64];

type Props = {
  reviewRef: RefObject<HTMLDetailsElement | null>;
  score: Score | null;
  original: Original | null;
  onShowOriginal: () => void;
  reviewWarnings: string[];
  currentMeasureIndex: number;
  corrections: ScoreCorrections;
};

/** “识谱校对”：核对提示、未闭合八度线、拍号、声部名称、音高校正与撤销。 */
export function ReviewPanel({
  reviewRef,
  score,
  original,
  onShowOriginal,
  reviewWarnings,
  currentMeasureIndex,
  corrections,
}: Props) {
  return (
    <details ref={reviewRef} id="review-settings" className="practice-disclosure review-settings">
      <summary>
        识谱校对<small>{original ? '原稿 · 音符 · 拍号' : '音符 · 拍号 · 名称'}</small>
      </summary>
      <div className="review-intro">
        <p>对照原稿核对音高、拍号与名称。试听顺畅不代表识别正确。</p>
        {original && (
          <button className="button quiet full-width" onClick={onShowOriginal}>
            查看原稿对照
          </button>
        )}
      </div>
      {score && reviewWarnings.length > 0 && (
        <section className="score-warnings">
          <h3>这份谱的核对与播放提示 · {reviewWarnings.length} 项</h3>
          <ul>
            {reviewWarnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </section>
      )}
      <section className="inspector-section">
        <OctaveShiftCheck score={score} octaves={corrections.octaves} />
        <MeterCorrectionForm score={score} meter={corrections.meter} />
      </section>
      <PartNameEditor score={score} partNames={corrections.partNames} />
      <NoteCorrection
        score={score}
        currentMeasureIndex={currentMeasureIndex}
        notes={corrections.notes}
        history={corrections.history}
      />
      <details className="practice-disclosure capability-settings">
        <summary>播放还原范围</summary>
        <section className="inspector-section">
          <p className="inspector-copy">
            支持基础音高、时值与声部练习。各声部可选择不同音色同时演奏，默认明亮钢琴。不模拟原谱的真实人声演唱。
          </p>
          <p className="micro-copy">
            复杂表达记号未完整还原，装饰音、奏法、渐强渐弱和踏板等以这份谱的播放提示为准。听起来流畅不代表识别无误。
          </p>
        </section>
      </details>
    </details>
  );
}

function OctaveShiftCheck({ score, octaves }: { score: Score | null; octaves: ScoreCorrections['octaves'] }) {
  if (!(octaves.openCount > 0)) return <p className="micro-copy">未发现未闭合八度线；仍需核对其他内容。</p>;
  return (
    <>
      <p className="micro-copy">发现 {octaves.openCount} 处未闭合八度线。排版兼容不表示这些线识别正确。</p>
      <button className="button quiet full-width" disabled={!score} onClick={() => octaves.setConfirming(true)}>
        移除未闭合八度线
      </button>
      {octaves.confirming && (
        <div className="scan-delete-confirm" role="group" aria-label="确认移除未闭合八度线">
          <p>仅在对照原谱确认没有这些线后移除，可撤销，不改音高。只修改浏览器校正版，不修改原始扫描。</p>
          <button className="text-button" onClick={() => void octaves.remove()}>
            确认移除
          </button>
          <button className="text-button" onClick={() => octaves.setConfirming(false)}>
            取消
          </button>
        </div>
      )}
    </>
  );
}

function MeterCorrectionForm({ score, meter }: { score: Score | null; meter: ScoreCorrections['meter'] }) {
  return (
    <form
      className="meter-correction-form"
      onSubmit={(e) => {
        e.preventDefault();
        meter.request();
      }}
    >
      <h3>拍号校正</h3>
      <p className="micro-copy">请按原谱填写，从所选小节开始生效，保留后续已有拍号变化。</p>
      <div className="meter-fields">
        <label>
          起点小节
          <input
            type="number"
            aria-label="拍号起点小节"
            min={1}
            max={score?.measures.length || 1}
            step={1}
            value={meter.measure}
            disabled={!score}
            onChange={(e) => meter.change('measure', Number(e.target.value))}
          />
        </label>
        <label>
          分子
          <input
            type="number"
            aria-label="拍号分子"
            min={1}
            max={32}
            step={1}
            value={meter.beats}
            disabled={!score}
            onChange={(e) => meter.change('beats', Number(e.target.value))}
          />
        </label>
        <label>
          分母
          <select
            aria-label="拍号分母"
            value={meter.beatType}
            disabled={!score}
            onChange={(e) => meter.change('beatType', Number(e.target.value))}
          >
            {beatTypes.map((value) => (
              <option value={value} key={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button type="submit" className="button quiet full-width" disabled={!score}>
        校正拍号
      </button>
      {meter.confirming && (
        <div className="scan-delete-confirm" role="group" aria-label="确认拍号校正">
          <p>
            仅修改拍号和小节边界，不会自动修复音符时值；后续原有拍号变化保留，可撤销。将从第 {meter.measure} 小节改为{' '}
            {meter.beats}/{meter.beatType}，应用到所有源声部。
          </p>
          <button type="button" className="text-button" onClick={() => void meter.apply()}>
            确认校正拍号
          </button>
          <button type="button" className="text-button" onClick={() => meter.setConfirming(false)}>
            取消
          </button>
        </div>
      )}
    </form>
  );
}

function PartNameEditor({ score, partNames }: { score: Score | null; partNames: ScoreCorrections['partNames'] }) {
  return (
    <section className="inspector-section part-names">
      <h3>声部名称</h3>
      {score?.parts
        .filter((part) => part.sourcePartId)
        .map((part) => (
          <div className="part-name-editor" key={part.id}>
            <div>
              <span>{part.name}</span>
              <button
                className="text-button"
                aria-label={`更改声部名称 ${part.name}`}
                onClick={() => partNames.begin(part.id)}
              >
                改名
              </button>
            </div>
            {partNames.renamingPartId === part.id && (
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  void partNames.save();
                }}
              >
                <label>
                  声部名称
                  <input
                    value={partNames.draft}
                    maxLength={120}
                    onChange={(event) => partNames.setDraft(event.target.value)}
                  />
                </label>
                <button className="button quiet" type="submit">
                  保存声部名称
                </button>
                <button className="text-button" type="button" onClick={() => partNames.setRenamingPartId(null)}>
                  取消
                </button>
              </form>
            )}
          </div>
        ))}
    </section>
  );
}

type NoteCorrectionProps = {
  score: Score | null;
  currentMeasureIndex: number;
  notes: ScoreCorrections['notes'];
  history: ScoreCorrections['history'];
};

function NoteCorrection({ score, currentMeasureIndex, notes, history }: NoteCorrectionProps) {
  const { selectedNote, visibleNotes, editPitch } = notes;
  return (
    <section className="review-note-section">
      <h3>音符校正</h3>
      <section className="inspector-section correction-section">
        <label className="field-label" htmlFor="note-select">
          第 {currentMeasureIndex + 1} 小节的音符
        </label>
        <select
          id="note-select"
          value={notes.selectedNoteId || ''}
          disabled={!score}
          onChange={(e) => notes.selectNote(e.target.value)}
        >
          <option value="">选择一个音符</option>
          {selectedNote && !visibleNotes.some((n) => n.id === selectedNote.id) && (
            <option value={selectedNote.id}>
              第 {selectedNote.measure} 小节 · {noteLabel(score, selectedNote)}
            </option>
          )}
          {visibleNotes.map((note) => (
            <option value={note.id} key={note.id}>
              {noteLabel(score, note)}
            </option>
          ))}
        </select>
        {selectedNote ? (
          <div className="note-editor">
            <div className="note-original">
              <span>原音高</span>
              <strong>{pitchName(selectedNote.midi)}</strong>
              <small>
                时值 {selectedNote.duration} 拍 · MIDI {selectedNote.midi}
              </small>
            </div>
            <label className="field-label" htmlFor="correct-pitch">
              改为 <span>{pitchName(editPitch)}</span>
            </label>
            <select id="correct-pitch" value={editPitch} onChange={(e) => notes.setEditPitch(Number(e.target.value))}>
              {Array.from({ length: 128 }, (_, midi) => (
                <option key={midi} value={midi}>
                  {pitchName(midi)} · MIDI {midi}
                </option>
              ))}
            </select>
            <button
              className="button ink full-width"
              onClick={() => void notes.correct()}
              disabled={selectedNote.midi === editPitch}
            >
              应用音高校正
            </button>
          </div>
        ) : (
          <div className="note-placeholder">
            <Icon name="pen" size={24} />
            <span>
              从上方列表精确选择音符。
              <br />
              点击谱面可辅助定位。
            </span>
          </div>
        )}
        <button
          className="text-button undo-button"
          disabled={!history.undo.length}
          onClick={() => void history.undoCorrection()}
        >
          <Icon name="undo" size={14} />
          撤销校正{history.undo.length ? ` · ${history.undo.length}` : ''}
        </button>
        <p className="micro-copy">按原调校正，保留最近 12 次修改。暂不编辑节奏、连线或布局。</p>
      </section>
    </section>
  );
}
