import { useState } from 'react';
import { exportMidi, scoreToWav, transposeXml } from '../music';
import type { Score } from '../music';
import type { InstrumentId } from '../music/instruments';
import { exportFileBase } from './score-helpers';
import type { SetNotice } from './types';

/** 通过临时链接触发浏览器下载。 */
export function download(data: string | Uint8Array, mime: string, name: string) {
  const content = typeof data === 'string' ? data : new Uint8Array(data).buffer;
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type ExportSettings = {
  tempo: number;
  transpose: number;
  followRepeats: boolean;
  partInstruments: Record<string, InstrumentId>;
  solo: string | null;
  muted: string[];
  loopStart: number;
  loopEnd: number;
};

/**
 * 导出 MusicXML（整首，含校正与移调）、MIDI 与 WAV。
 * 音频与 MIDI 可只导出“起始小节 — 结束小节”这一段，演奏一次、不展开反复。
 */
export function useScoreExport(score: Score | null, settings: ExportSettings, setNotice: SetNotice) {
  const [exportScope, setExportScope] = useState<'full' | 'excerpt'>('full');
  const [exporting, setExporting] = useState(false);

  async function exportScore(format: 'xml' | 'midi' | 'wav') {
    if (!score) return;
    const { tempo, transpose, followRepeats, partInstruments, solo, muted, loopStart, loopEnd } = settings;
    setExporting(true);
    try {
      // 先让“正在生成文件…”渲染出来，再开始可能较慢的合成。
      await new Promise(resolve => window.setTimeout(resolve, 0));
      const filename = exportFileBase(score.title);
      const excerpt = format !== 'xml' && exportScope === 'excerpt';
      if (
        excerpt &&
        (!Number.isInteger(loopStart) ||
          !Number.isInteger(loopEnd) ||
          loopStart < 1 ||
          loopEnd < loopStart ||
          loopEnd > score.measures.length)
      ) {
        throw new Error('请选择有效的整数起止小节后再导出。');
      }
      const options = {
        tempo,
        transpose,
        followRepeats,
        partInstruments,
        mutedParts: solo ? score.parts.filter(p => p.id !== solo).map(p => p.id) : muted,
        ...(excerpt ? { measureRange: { start: loopStart, end: loopEnd } } : {}),
      };
      const audioFilename = excerpt ? `${filename}-小节-${loopStart}-${loopEnd}` : filename;
      if (format === 'xml') {
        download(transposeXml(score.xml, transpose), 'application/vnd.recordare.musicxml+xml', `${filename}.musicxml`);
      }
      if (format === 'midi') download(exportMidi(score, options), 'audio/midi', `${audioFilename}.mid`);
      if (format === 'wav') download(await scoreToWav(score, options), 'audio/wav', `${audioFilename}.wav`);
      setNotice({
        kind: 'info',
        text:
          format === 'xml'
            ? '已导出整首 MusicXML，保留校正、移调和反复记号，不按所选小节截取。'
            : `已生成 ${format.toUpperCase()} 文件。${excerpt ? `第 ${loopStart} 至 ${loopEnd} 小节演奏一次，不展开谱面反复。` : '整首使用当前谱面反复设置，不截取手动循环范围。'} 使用当前速度、移调、声部与所选音色，不含预备拍或节拍器。`,
      });
    } catch (e) {
      setNotice({ kind: 'error', text: `导出失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setExporting(false);
    }
  }

  /** 打开另一份谱时回到“整首”。 */
  function reset() {
    setExportScope('full');
  }

  return { exportScope, setExportScope, exporting, exportScore, reset };
}

export type ScoreExport = ReturnType<typeof useScoreExport>;
