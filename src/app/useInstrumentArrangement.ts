import { useMemo, useState } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { Score, ScorePlayer } from '../music';
import { DEFAULT_INSTRUMENT, getInstrumentWarnings, isInstrumentId } from '../music/instruments';
import type { InstrumentId } from '../music/instruments';
import { ARRANGEMENTS, allPartsInstrumentMap, getArrangementMap } from '../music/arrangements';
import type { ArrangementPreset } from '../music/arrangements';
import type { PracticeSession } from '../practice/session';
import { instrumentMap } from './score-helpers';
import type { SetNotice } from './types';

type Options = {
  score: Score | null;
  partInstruments: Record<string, InstrumentId>;
  setPartInstruments: Dispatch<SetStateAction<Record<string, InstrumentId>>>;
  player: RefObject<ScorePlayer | null>;
  sessionRef: RefObject<PracticeSession | null>;
  saveCurrent: () => void;
  setNotice: SetNotice;
};

/**
 * “声音”分区：整首配器预设、全部换成某一音色、逐个声部换音色。
 * 新映射立即交给播放器并写入会话，不打断播放位置与其他练习设置。
 */
export function useInstrumentArrangement({
  score,
  partInstruments,
  setPartInstruments,
  player,
  sessionRef,
  saveCurrent,
  setNotice,
}: Options) {
  const [arrangementPreset, setArrangementPreset] = useState('none');
  const [showInstrumentDetails, setShowInstrumentDetails] = useState(false);

  const instrumentWarnings = useMemo(
    () => (score ? getInstrumentWarnings(score, partInstruments) : []),
    [score, partInstruments],
  );

  function applyInstrumentMap(map: Record<string, InstrumentId>, message: string) {
    if (!score) return;
    const next = instrumentMap(map, score);
    const changed = score.parts.some(
      part => (partInstruments[part.id] ?? DEFAULT_INSTRUMENT) !== (next[part.id] ?? DEFAULT_INSTRUMENT),
    );
    if (!changed) return;
    player.current?.setPartInstruments(next);
    setPartInstruments(next);
    if (sessionRef.current) {
      sessionRef.current = { ...sessionRef.current, partInstruments: { ...next } };
      saveCurrent();
    }
    setNotice({ kind: 'info', text: message });
  }

  function applyArrangement(value: string) {
    if (!score) return;
    if (value === 'none') {
      setArrangementPreset('none');
      return;
    }
    if (!ARRANGEMENTS.some(item => item.id === value)) return;
    try {
      const next = getArrangementMap(score, value as ArrangementPreset);
      applyInstrumentMap(next, '整首配器已更新，按播放继续。速度、播放位置、只听、静音和循环设置保留。');
      setArrangementPreset(value);
    } catch (e) {
      setNotice({ kind: 'error', text: `配器更新失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  function applyAllInstruments(value: string) {
    if (!score || !isInstrumentId(value)) return;
    try {
      const next = allPartsInstrumentMap(score, value);
      applyInstrumentMap(next, '全部声部音色已更新，按播放继续。其他练习设置保留。');
      setArrangementPreset('none');
    } catch (e) {
      setNotice({ kind: 'error', text: `配器更新失败：${e instanceof Error ? e.message : String(e)}` });
    }
  }

  function changePartInstrument(partId: string, value: string) {
    if (!score || !isInstrumentId(value)) return;
    const part = score.parts.find(item => item.id === partId);
    if (!part || (value === 'drums' && !part.notes.some(note => note.percussion !== undefined))) return;
    if ((partInstruments[partId] ?? DEFAULT_INSTRUMENT) === value) return;
    setArrangementPreset('none');
    applyInstrumentMap(
      { ...partInstruments, [partId]: value },
      '音色已更换，按播放继续。播放位置、校正乐谱和其他声部设置保留。',
    );
  }

  /** 打开另一份谱时回到“当前配器”并收起逐个调整。 */
  function reset() {
    setArrangementPreset('none');
    setShowInstrumentDetails(false);
  }

  return {
    arrangementPreset,
    showInstrumentDetails,
    setShowInstrumentDetails,
    instrumentWarnings,
    applyArrangement,
    applyAllInstruments,
    changePartInstrument,
    reset,
  };
}

export type InstrumentArrangement = ReturnType<typeof useInstrumentArrangement>;
