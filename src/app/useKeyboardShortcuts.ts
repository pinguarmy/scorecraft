import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Score } from '../music';

type Options = {
  togglePlay: () => Promise<void>;
  score: Score | null;
  currentMeasureIndex: number;
  seek: (beat: number) => void;
  /** 快捷键对话框或窄屏工具面板打开时，不接管按键。 */
  showKeys: boolean;
  compactLayout: boolean;
  mobileToolsOpen: boolean;
  setMetronome: Dispatch<SetStateAction<boolean>>;
  setLoop: Dispatch<SetStateAction<boolean>>;
  openShortcuts: () => void;
};

/**
 * 全局练习快捷键：空格播放/暂停、←/→ 换小节、Home 回到开头、M 节拍器、L 循环、? 帮助。
 * 焦点在输入框、选择框、按钮或可编辑区域上，或按下修饰键时不处理。
 */
export function useKeyboardShortcuts({
  togglePlay,
  score,
  currentMeasureIndex,
  seek,
  showKeys,
  compactLayout,
  mobileToolsOpen,
  setMetronome,
  setLoop,
  openShortcuts,
}: Options) {
  useEffect(() => {
    function keydown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (
        showKeys ||
        (compactLayout && mobileToolsOpen) ||
        target.closest('input, select, textarea, button, [contenteditable="true"]') ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey
      ) {
        return;
      }
      if (e.code === 'Space') {
        e.preventDefault();
        void togglePlay();
      }
      if (!score) return;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const index = Math.max(
          0,
          Math.min(score.measures.length - 1, currentMeasureIndex + (e.key === 'ArrowRight' ? 1 : -1)),
        );
        seek(score.measures[index].startBeat);
      }
      if (e.key === 'Home') {
        e.preventDefault();
        seek(0);
      }
      if (e.key.toLowerCase() === 'm') setMetronome((v) => !v);
      if (e.key.toLowerCase() === 'l') setLoop((v) => !v);
      if (e.key === '?') openShortcuts();
    }
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  }, [
    togglePlay,
    score,
    currentMeasureIndex,
    seek,
    showKeys,
    compactLayout,
    mobileToolsOpen,
    setMetronome,
    setLoop,
    openShortcuts,
  ]);
}
