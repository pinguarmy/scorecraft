import { useEffect, useState } from 'react';
import type { RefObject } from 'react';
import type { Score, ScorePlayer } from '../music';
import type { InstrumentId } from '../music/instruments';
import { sanitizeSession } from '../practice/session';
import type { PracticeSession } from '../practice/session';
import { instrumentMap, scoreBounds } from './score-helpers';

type Options = {
  score: Score | null;
  player: RefObject<ScorePlayer | null>;
  sessionRef: RefObject<PracticeSession | null>;
  saveRef: RefObject<() => void>;
};

/**
 * 每份谱各自保存的练习设置（速度、移调、节拍器、预备拍、声部、循环、跟谱）。
 *
 * 任何一项变化都写回 sessionRef 并保存；同时逐项同步给播放器。
 * 切换乐谱时由 applySession 一次性载入保存的设置（播放器那一侧由 configurePlayer 负责）。
 */
export function usePracticeSettings({ score, player, sessionRef, saveRef }: Options) {
  const [followRepeats, setFollowRepeats] = useState(true);
  const [followMode, setFollowMode] = useState<'scroll' | 'page'>('scroll');
  const [followEnabled, setFollowEnabled] = useState(true);
  const [tempo, setTempo] = useState(88);
  const [transpose, setTranspose] = useState(0);
  const [metronome, setMetronome] = useState(false);
  const [countIn, setCountIn] = useState(false);
  const [muted, setMuted] = useState<string[]>([]);
  const [partInstruments, setPartInstruments] = useState<Record<string, InstrumentId>>({});
  const [solo, setSolo] = useState<string | null>(null);
  const [loop, setLoop] = useState(false);
  const [loopStart, setLoopStart] = useState(1);
  const [loopEnd, setLoopEnd] = useState(1);

  useEffect(() => {
    if (!score || !sessionRef.current) return;
    sessionRef.current = sanitizeSession(
      {
        ...sessionRef.current,
        tempo,
        transpose,
        metronome,
        countIn,
        partInstruments,
        muted,
        solo,
        loop,
        loopStart,
        loopEnd,
        followRepeats,
        followMode,
        followEnabled,
      },
      scoreBounds(score),
    );
    saveRef.current();
  }, [
    score,
    tempo,
    transpose,
    metronome,
    countIn,
    partInstruments,
    muted,
    solo,
    loop,
    loopStart,
    loopEnd,
    followRepeats,
    followMode,
    followEnabled,
  ]);
  useEffect(() => {
    player.current?.setFollowRepeats(followRepeats);
  }, [followRepeats, score]);
  useEffect(() => {
    player.current?.setTempo(tempo);
  }, [tempo, score]);
  useEffect(() => {
    player.current?.setTranspose(transpose);
  }, [transpose, score]);
  useEffect(() => {
    player.current?.setMetronome(metronome);
  }, [metronome, score]);
  useEffect(() => {
    player.current?.setCountIn(countIn);
  }, [countIn, score]);
  useEffect(() => {
    if (score) player.current?.setPartInstruments(partInstruments);
  }, [partInstruments, score]);
  useEffect(() => {
    if (score) player.current?.setMutedParts(solo ? score.parts.filter((p) => p.id !== solo).map((p) => p.id) : muted);
  }, [muted, solo, score]);
  useEffect(() => {
    if (!score) return;
    const start = score.measures[loopStart - 1]?.startBeat ?? 0;
    const last = score.measures[loopEnd - 1];
    player.current?.setLoop(start, last ? last.startBeat + last.duration : score.totalBeats, loop);
  }, [score, loop, loopStart, loopEnd]);

  /** 载入一份谱保存的设置（已经过 sanitizeSession）。 */
  function applySession(settings: PracticeSession, next: Score) {
    setTempo(settings.tempo);
    setTranspose(settings.transpose);
    setMetronome(settings.metronome);
    setCountIn(settings.countIn);
    setPartInstruments(instrumentMap(settings.partInstruments ?? {}, next));
    setMuted(settings.muted);
    setSolo(settings.solo);
    setLoop(settings.loop);
    setLoopStart(settings.loopStart);
    setLoopEnd(settings.loopEnd);
    setFollowRepeats(settings.followRepeats);
    setFollowMode(settings.followMode ?? 'scroll');
    setFollowEnabled(settings.followEnabled ?? true);
  }

  /** “全部声部”：取消只听与静音。 */
  function hearAllParts() {
    setSolo(null);
    setMuted([]);
  }

  return {
    tempo,
    setTempo,
    transpose,
    setTranspose,
    metronome,
    setMetronome,
    countIn,
    setCountIn,
    muted,
    setMuted,
    partInstruments,
    setPartInstruments,
    solo,
    setSolo,
    loop,
    setLoop,
    loopStart,
    setLoopStart,
    loopEnd,
    setLoopEnd,
    followRepeats,
    setFollowRepeats,
    followMode,
    setFollowMode,
    followEnabled,
    setFollowEnabled,
    applySession,
    hearAllParts,
  };
}

export type PracticeSettings = ReturnType<typeof usePracticeSettings>;
