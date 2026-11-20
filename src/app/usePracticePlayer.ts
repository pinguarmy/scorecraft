import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { ScorePlayer } from '../music';
import type { Score } from '../music';
import type { PracticeSession } from '../practice/session';
import type { createLibrarySaver } from '../practice/library';
import type { SetNotice } from './types';

type Options = {
  /** 切换乐谱期间为 true：播放器回调此时不写会话、不保存、不显示“预备拍已取消”。 */
  switchingRef: RefObject<boolean>;
  sessionRef: RefObject<PracticeSession | null>;
  /** 总是指向最新一次渲染的 saveCurrent。 */
  saveRef: RefObject<() => void>;
  librarySaver: RefObject<ReturnType<typeof createLibrarySaver> | null>;
  /** 打开乐谱的请求；卸载时一并中止。 */
  request: RefObject<AbortController | null>;
  scoreRef: RefObject<Score | null>;
  setNotice: SetNotice;
};

/**
 * 播放器实例及其回调状态：是否在播、音色加载、播放位置、预备拍。
 *
 * 回调里用 playingRef / countingRef / countEndedRef 读取最新值，
 * 以判断停止是否发生在预备拍中（或刚结束、尚未出声时），从而提示“预备拍已取消”。
 * 播放中每 5 秒保存一次位置；暂停、页面隐藏或关闭时立即保存并刷新保存队列。
 */
export function usePracticePlayer({
  switchingRef,
  sessionRef,
  saveRef,
  librarySaver,
  request,
  scoreRef,
  setNotice,
}: Options) {
  const [playing, setPlaying] = useState(false);
  const [audioState, setAudioState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [audioMessage, setAudioMessage] = useState('');
  const [position, setPosition] = useState(0);
  const [countInRemaining, setCountInRemaining] = useState<number | null>(null);
  const [countInCancelled, setCountInCancelled] = useState(false);
  const player = useRef<ScorePlayer | null>(null);
  const playingRef = useRef(false);
  const lastPositionSave = useRef(0);
  const countingRef = useRef(false);
  const countEndedRef = useRef(false);

  useEffect(() => {
    const p = new ScorePlayer({
      onAudioState: (state, message) => {
        setAudioState(state);
        setAudioMessage(message || '');
      },
      onPosition: beat => {
        if (!countingRef.current && playingRef.current) countEndedRef.current = false;
        setPosition(beat);
        if (!switchingRef.current && sessionRef.current) {
          sessionRef.current.position = beat;
          if (!playingRef.current || Date.now() - lastPositionSave.current >= 5000) {
            lastPositionSave.current = Date.now();
            saveRef.current();
          }
        }
      },
      onState: value => {
        playingRef.current = value;
        setPlaying(value);
        if (value) setCountInCancelled(false);
        else {
          if (!switchingRef.current && (countingRef.current || countEndedRef.current)) setCountInCancelled(true);
          countingRef.current = false;
          countEndedRef.current = false;
          setCountInRemaining(null);
          if (!switchingRef.current) {
            saveRef.current();
            void librarySaver.current?.flush();
          }
        }
      },
      onCountIn: remaining => {
        if (remaining !== null && Number.isFinite(remaining)) {
          countingRef.current = true;
          countEndedRef.current = false;
          setCountInCancelled(false);
          const displayed = Math.max(0, Math.round(remaining * 1000) / 1000);
          setCountInRemaining(previous => (previous === displayed ? previous : displayed));
        } else {
          const wasCounting = countingRef.current;
          countingRef.current = false;
          countEndedRef.current = wasCounting;
          setCountInRemaining(null);
          if (wasCounting && !playingRef.current && !switchingRef.current) setCountInCancelled(true);
        }
      },
    });
    player.current = p;
    const save = () => {
      saveRef.current();
      void librarySaver.current?.flush();
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') save();
    };
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      save();
      switchingRef.current = true;
      p.dispose();
      player.current = null;
      request.current?.abort();
      window.removeEventListener('pagehide', save);
      document.removeEventListener('visibilitychange', visibility);
      switchingRef.current = false;
    };
  }, []);

  /** 切换乐谱时清除预备拍状态（与播放器的 stop 回调配合）。 */
  function resetCountIn() {
    countingRef.current = false;
    countEndedRef.current = false;
    setCountInRemaining(null);
    setCountInCancelled(false);
  }

  const seek = useCallback((beat: number) => {
    player.current?.seek(beat);
    setPosition(beat);
  }, []);

  const togglePlay = useCallback(async () => {
    if (!scoreRef.current) return;
    try {
      if (playing || audioState === 'loading') player.current?.pause();
      else await player.current?.play();
    } catch (e) {
      setNotice({ kind: 'error', text: `无法播放：${e instanceof Error ? e.message : String(e)}` });
    }
  }, [playing, audioState]);

  function stopAndRewind() {
    player.current?.stop();
    setPosition(0);
  }

  return {
    player,
    playing,
    setPlaying,
    audioState,
    audioMessage,
    position,
    setPosition,
    countInRemaining,
    countInCancelled,
    resetCountIn,
    seek,
    togglePlay,
    stopAndRewind,
  };
}

export type PracticePlayer = ReturnType<typeof usePracticePlayer>;
