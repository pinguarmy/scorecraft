import type { Score } from '../music';
import type { ScoreExport } from '../app/useScoreExport';
import { Icon } from './Icon';

type Props = {
  score: Score | null;
  exporter: ScoreExport;
  loopStart: number;
  loopEnd: number;
};

/** “导出乐谱与音频”：选择范围并导出 MusicXML / MIDI / WAV。 */
export function ExportPanel({ score, exporter, loopStart, loopEnd }: Props) {
  const { exportScope, exporting } = exporter;
  return (
    <details id="export-settings" className="practice-disclosure export-settings">
      <summary>导出乐谱与音频</summary>
      <section className="inspector-section export-section">
        <div className="section-heading">
          <h2>把练习带走</h2>
          <Icon name="download" size={17} />
        </div>
        <label className="field-label" htmlFor="export-scope">
          音频与 MIDI 导出范围
        </label>
        <select
          id="export-scope"
          className="export-scope-select"
          value={exportScope}
          disabled={!score || exporting}
          onChange={(e) => exporter.setExportScope(e.target.value === 'excerpt' ? 'excerpt' : 'full')}
        >
          <option value="full">整首</option>
          <option value="excerpt">所选小节</option>
        </select>
        <p className="micro-copy export-scope-description">
          {exportScope === 'excerpt' && score
            ? `第 ${loopStart} 至 ${loopEnd} 小节，演奏一次，不展开谱面反复。使用上方起止小节，无需开启循环。`
            : '整首使用当前谱面反复设置。'}{' '}
          MusicXML 始终为整首。
        </p>
        <div className="export-buttons">
          <button disabled={!score || exporting} onClick={() => void exporter.exportScore('xml')}>
            MusicXML<span>整首乐谱</span>
          </button>
          <button disabled={!score || exporting} onClick={() => void exporter.exportScore('midi')}>
            MIDI<span>音符</span>
          </button>
          <button disabled={!score || exporting} onClick={() => void exporter.exportScore('wav')}>
            WAV<span>音频</span>
          </button>
        </div>
        <p className="micro-copy">
          XML 保留校正、移调和反复记号。MIDI / WAV 使用当前速度、声部和所选音色，不含预备拍或节拍器。
          {exporting ? ' 正在生成文件…' : ''}
        </p>
      </section>
    </details>
  );
}
