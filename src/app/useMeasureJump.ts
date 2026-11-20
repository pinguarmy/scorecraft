import { useEffect, useRef, useState } from 'react';
import type { Score } from '../music';

type Options = {
  score: Score | null;
  currentMeasureIndex: number;
  seek: (beat: number) => void;
};

/**
 * “跳到小节”输入框。未聚焦时跟随播放位置显示当前小节；
 * 聚焦后不再覆盖用户正在输入的内容。
 */
export function useMeasureJump({ score, currentMeasureIndex, seek }: Options) {
  const [jumpMeasure, setJumpMeasure] = useState('1');
  const [jumpError, setJumpError] = useState('');
  const jumpFocused = useRef(false);

  useEffect(() => {
    if (!jumpFocused.current) {
      setJumpMeasure(String(currentMeasureIndex + 1));
      setJumpError('');
    }
  }, [currentMeasureIndex, score]);

  function jumpToMeasure() {
    if (!score) return;
    const number = Number(jumpMeasure);
    if (!jumpMeasure.trim() || !Number.isInteger(number) || number < 1 || number > score.measures.length) {
      setJumpError(`请输入 1 至 ${score.measures.length} 的整数小节号。`);
      return;
    }
    setJumpError('');
    seek(score.measures[number - 1].startBeat);
  }

  /** 切换乐谱时，显示恢复的播放位置所在小节。 */
  function resetForScore(next: Score, position: number) {
    setJumpMeasure(String(Math.max(1, next.measures.findLastIndex((measure) => measure.startBeat <= position) + 1)));
    setJumpError('');
  }

  function changeJumpMeasure(value: string) {
    setJumpMeasure(value);
    setJumpError('');
  }

  return { jumpMeasure, jumpError, jumpFocused, jumpToMeasure, resetForScore, changeJumpMeasure };
}

export type MeasureJump = ReturnType<typeof useMeasureJump>;
