import type { Score } from '../music/types';
import type { ScorePlayer } from '../music/player';
import type { PracticeSession } from '../practice/session';
import { instrumentMap } from './score-helpers';

export type ConfigurablePlayer = Pick<
  ScorePlayer,
  | 'load'
  | 'setTempo'
  | 'setTranspose'
  | 'setMetronome'
  | 'setCountIn'
  | 'setPartInstruments'
  | 'setMutedParts'
  | 'setFollowRepeats'
  | 'setLoop'
  | 'seek'
>;

/**
 * 切换乐谱时一次性把整份练习设置交给播放器，再定位到保存的位置。
 * 之后的单项变化由 usePracticeSettings 中的 effect 同步。
 */
export function configurePlayer(p: ConfigurablePlayer | null, next: Score, session: PracticeSession) {
  if (!p) return;
  p.load(next);
  p.setTempo(session.tempo);
  p.setTranspose(session.transpose);
  p.setMetronome(session.metronome);
  p.setCountIn(session.countIn);
  p.setPartInstruments(instrumentMap(session.partInstruments ?? {}, next));
  p.setMutedParts(
    session.solo ? next.parts.filter((part) => part.id !== session.solo).map((part) => part.id) : session.muted,
  );
  p.setFollowRepeats(session.followRepeats);
  const last = next.measures[session.loopEnd - 1];
  p.setLoop(
    next.measures[session.loopStart - 1]?.startBeat || 0,
    last ? last.startBeat + last.duration : next.totalBeats,
    session.loop,
  );
  p.seek(session.position);
}
