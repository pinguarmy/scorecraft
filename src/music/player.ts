import type { Score, ScoreNote, ScoreMeasure } from './types';
import { getPlaybackScore, playbackToSource, sourceToPlayback } from './playback';
import { PIANO_MASTER_GAIN } from './piano';
import {
  loadInstrumentBank,
  scheduleInstrumentNote,
  DEFAULT_INSTRUMENT,
  isInstrumentId,
  type InstrumentId,
  type InstrumentBank,
  type InstrumentVoice,
} from './instruments';

type Callbacks = {
  onPosition?: (beat: number) => void;
  onState?: (playing: boolean) => void;
  onCountIn?: (remaining: number | null) => void;
  onAudioState?: (state: 'idle' | 'loading' | 'ready' | 'error', message?: string) => void;
};
type CountIn = { startTime: number; endTime: number; duration: number; nextClick: number; remaining: number };
type PartSchedule = { sortedNotes: ScoreNote[]; cursor: number; maxDuration: number };

function lowerBound(notes: readonly ScoreNote[], beat: number): number {
  let low = 0;
  let high = notes.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (notes[mid].beat < beat) low = mid + 1;
    else high = mid;
  }
  return low;
}

function findMeasure(measures: readonly ScoreMeasure[], beat: number) {
  let low = 0;
  let high = measures.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const m = measures[mid];
    if (beat < m.startBeat) high = mid - 1;
    else if (beat >= m.startBeat + m.duration) low = mid + 1;
    else return m;
  }
  return undefined;
}

/** Local per-part instruments. Synthetic presets are explicit registry choices only. */
export class ScorePlayer {
  private score?: Score;
  private performance?: Score;
  private scoreParts = new Map<string, PartSchedule>();
  private performanceParts = new Map<string, PartSchedule>();
  private followRepeats = true;
  private context?: AudioContext;
  private master?: GainNode;
  private timer?: ReturnType<typeof setInterval>;
  private voices = new Set<OscillatorNode | InstrumentVoice>();
  private banks = new Map<InstrumentId, InstrumentBank>();
  private partInstruments: Record<string, InstrumentId> = {};
  private loading = false;
  private callbacks: Callbacks;
  private playing = false;
  private position = 0;
  private anchorTime = 0;
  private anchorBeat = 0;
  private scheduledUntil = 0;
  private tempo = 100;
  private transpose = 0;
  private muted = new Set<string>();
  private loop = { start: 0, end: 0, enabled: false };
  private metronome = false;
  private generation = 0;
  private countInEnabled = false;
  private counting?: CountIn;
  private disposed = false;
  constructor(callbacks: Callbacks = {}) {
    this.callbacks = callbacks;
  }
  load(score: Score): void {
    this.stop();
    this.partInstruments = {};
    this.score = score;
    this.performance = getPlaybackScore(score);
    this.scoreParts = this.prepareScheduleData(score);
    this.performanceParts = this.performance ? this.prepareScheduleData(this.performance) : new Map();
    this.followRepeats = true;
    this.tempo = score.tempo;
    this.loop = { start: 0, end: score.totalBeats, enabled: false };
  }
  private prepareScheduleData(score: Score): Map<string, PartSchedule> {
    const map = new Map<string, PartSchedule>();
    for (const part of score.parts) {
      const sorted = [...part.notes].sort((a, b) => a.beat - b.beat);
      let maxDuration = 0;
      for (const note of sorted) {
        if (note.duration > maxDuration) maxDuration = note.duration;
      }
      map.set(part.id, { sortedNotes: sorted, cursor: 0, maxDuration });
    }
    return map;
  }
  private activeScheduleData(): Map<string, PartSchedule> {
    return this.writtenRepeats() ? this.performanceParts : this.scoreParts;
  }
  private resetCursors(beat: number): void {
    for (const data of this.activeScheduleData().values()) {
      data.cursor = lowerBound(data.sortedNotes, beat - 1e-7);
    }
  }
  private currentBeat(): number {
    return this.playing && this.context && !this.counting
      ? this.anchorBeat + ((this.context.currentTime - this.anchorTime) * this.tempo) / 60
      : this.position;
  }
  private writtenRepeats(): boolean {
    return this.followRepeats && !this.loop.enabled && !!this.score?.playback?.expanded;
  }
  private activeScore(): Score | undefined {
    return this.writtenRepeats() ? this.performance : this.score;
  }
  private sourceBeat(beat: number): number {
    return this.writtenRepeats() && this.score ? playbackToSource(this.score, beat) : beat;
  }
  private playBeat(beat: number): number {
    return this.writtenRepeats() && this.score ? sourceToPlayback(this.score, beat) : beat;
  }
  private limit(): number {
    return this.loop.enabled ? this.loop.end : this.activeScore()?.totalBeats || 0;
  }
  private silence(): void {
    for (const voice of this.voices) {
      try {
        voice.stop();
      } catch {
        /* Already ended. */
      }
    }
    this.voices.clear();
  }
  private resetSchedule(beat: number): void {
    this.silence();
    this.position = beat;
    this.anchorBeat = beat;
    this.anchorTime = this.context?.currentTime || 0;
    this.scheduledUntil = beat;
    this.resetCursors(beat);
  }
  async play(): Promise<void> {
    if (!this.score || this.playing || this.loading || this.disposed) return;
    const generation = ++this.generation;
    if (!this.context) {
      const Constructor =
        globalThis.AudioContext ||
        (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Constructor) throw new Error('此浏览器不支持 Web Audio，请下载 MIDI 或 WAV。');
      this.context = new Constructor();
      this.master = this.context.createGain();
      this.master.gain.value = PIANO_MASTER_GAIN;
      this.master.connect(this.context.destination);
    }
    this.loading = true;
    try {
      this.callbacks.onAudioState?.('loading', '正在加载本机音色…');
      if (generation !== this.generation || this.disposed) return;
      await this.context.resume();
      if (generation !== this.generation || !this.score || this.disposed) return;
      const required = [
        ...new Set(
          this.score.parts
            .filter((part) => !this.muted.has(part.id) && part.notes.length > 0)
            .map((part) => this.partInstruments[part.id] ?? DEFAULT_INSTRUMENT),
        ),
      ];
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(3, required.length) }, async () => {
          while (next < required.length) {
            const id = required[next++];
            if (!this.banks.has(id)) {
              const bank = await loadInstrumentBank(this.context!, id);
              if (generation !== this.generation || this.disposed) return;
              this.banks.set(id, bank);
            }
            if (generation !== this.generation || this.disposed) return;
          }
        }),
      );
      if (generation !== this.generation || !this.score || this.disposed) return;
      this.loading = false;
      this.callbacks.onAudioState?.('ready', '所选本机音色已就绪。');
    } catch (error) {
      if (generation !== this.generation || this.disposed) return;
      this.loading = false;
      const message = error instanceof Error ? error.message : '本机音色加载失败，请重试。';
      this.callbacks.onAudioState?.('error', message);
      this.callbacks.onState?.(false);
      throw error;
    }
    if (generation !== this.generation || !this.score || this.disposed) return;
    if (this.position >= this.limit() || (this.loop.enabled && this.position < this.loop.start))
      this.position = this.loop.enabled ? this.loop.start : 0;
    this.playing = true;
    this.resetSchedule(this.position);
    if (this.countInEnabled) {
      const source = this.sourceBeat(this.position);
      const measure = this.score.measures.find((m) => source >= m.startBeat && source < m.startBeat + m.duration);
      const duration = measure?.duration;
      if (duration && Number.isFinite(duration) && duration > 0) {
        const startTime = this.context.currentTime;
        this.counting = {
          startTime,
          endTime: startTime + (duration * 60) / this.tempo,
          duration,
          nextClick: 0,
          remaining: duration,
        };
      }
    }
    this.callbacks.onState?.(true);
    if (this.counting) this.callbacks.onCountIn?.(this.counting.remaining);
    if (generation !== this.generation || !this.playing) return;
    this.tick();
    if (this.playing && generation === this.generation) this.timer = setInterval(() => this.tick(), 25);
  }
  private tone(midi: number, velocity: number, at: number, duration: number, click = false, deadline = Infinity): void {
    if (!this.context || !this.master || duration <= 0) return;
    if (!click) throw new Error('乐器播放必须使用真实钢琴采样。');
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = 'square';
    oscillator.frequency.value = 440 * 2 ** ((midi - 69) / 12);
    const start = Math.max(this.context.currentTime, at);
    const end = Math.min(deadline, start + Math.max(0.015, duration));
    if (end <= start) return;
    const volume = click ? 0.06 : Math.min(0.12, (velocity / 127) * 0.12);
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(volume, Math.min(start + 0.008, end));
    gain.gain.exponentialRampToValueAtTime(
      Math.max(0.0001, volume * 0.5),
      Math.min(end, Math.max(start + 0.01, end - 0.025)),
    );
    gain.gain.linearRampToValueAtTime(0, Math.min(deadline, end + 0.025));
    oscillator.connect(gain);
    gain.connect(this.master);
    this.voices.add(oscillator);
    oscillator.onended = () => {
      this.voices.delete(oscillator);
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(start);
    oscillator.stop(Math.min(deadline, end + 0.035));
  }
  private tick(): void {
    if (!this.playing || !this.score || !this.context || this.disposed) return;
    if (this.counting) {
      const count = this.counting;
      const elapsed = Math.max(0, ((this.context.currentTime - count.startTime) * this.tempo) / 60);
      if (this.context.currentTime < count.endTime) {
        const until = Math.min(count.duration, elapsed + (0.12 * this.tempo) / 60);
        count.nextClick = Math.max(count.nextClick, Math.ceil(elapsed - (0.025 * this.tempo) / 60));
        // Reuse the same audio-clock lookahead as music. Missed clicks are skipped,
        // not bunched together after a background-tab scheduler delay.
        while (count.nextClick < until) {
          const beat = count.nextClick++;
          const at = count.startTime + (beat * 60) / this.tempo;
          if (at + 0.025 < this.context.currentTime) continue;
          this.tone(
            beat === 0 ? 96 : 89,
            100,
            at,
            Math.min(0.025, count.endTime - Math.max(at, this.context.currentTime)),
            true,
            count.endTime,
          );
        }
        const remaining = count.duration - Math.min(Math.floor(elapsed + 1e-7), Math.ceil(count.duration) - 1);
        if (remaining !== count.remaining) {
          count.remaining = remaining;
          this.callbacks.onCountIn?.(remaining);
        }
        return;
      }
      this.counting = undefined;
      // Preserve the exact audio deadline and performance beat, including repeat pass.
      this.anchorTime = count.endTime;
      this.anchorBeat = this.position;
      this.scheduledUntil = this.position;
      this.callbacks.onCountIn?.(null);
      if (!this.playing || this.disposed) return;
    }
    let now = this.currentBeat();
    const end = this.limit();
    if (now >= end) {
      if (this.loop.enabled && this.loop.end > this.loop.start) {
        const loopLength = this.loop.end - this.loop.start;
        const loopDuration = (loopLength * 60) / this.tempo;
        const overshootBeats = Math.max(0, now - this.loop.end);
        const loopsToSkip = Math.floor(overshootBeats / loopLength);
        const firstBoundaryTime = this.anchorTime + ((this.loop.end - this.anchorBeat) * 60) / this.tempo;
        this.silence();
        this.anchorTime = firstBoundaryTime + loopsToSkip * loopDuration;
        this.anchorBeat = this.loop.start;
        this.scheduledUntil = this.loop.start;
        this.resetCursors(this.loop.start);
        now = this.loop.start + (overshootBeats - loopsToSkip * loopLength);
      } else {
        // Natural completion retains the scheduled piano release. Explicit pause/stop
        // still silence all nodes immediately and invalidate pending work.
        ++this.generation;
        this.playing = false;
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        this.position = end;
        this.callbacks.onState?.(false);
        this.callbacks.onPosition?.(this.score.totalBeats);
        return;
      }
    }
    const from = this.scheduledUntil;
    // Audio nodes run on the audio clock even when notation/layout blocks the
    // main thread briefly. Keep UI position on `now`, not this future horizon.
    const until = Math.min(end, now + (0.65 * this.tempo) / 60);
    const active = this.activeScore()!;
    const scheduleData = this.activeScheduleData();
    const isWindowStart = from === this.anchorBeat;

    for (const part of active.parts) {
      if (this.muted.has(part.id)) continue;
      const data = scheduleData.get(part.id);
      if (!data) continue;

      if (
        data.cursor >= data.sortedNotes.length ||
        data.sortedNotes[data.cursor].beat < from - 1e-7 ||
        (data.cursor > 0 && data.sortedNotes[data.cursor - 1].beat >= from - 1e-7)
      ) {
        data.cursor = lowerBound(data.sortedNotes, from - 1e-7);
      }

      if (isWindowStart && data.maxDuration > 0) {
        const sustainStart = lowerBound(data.sortedNotes, from - data.maxDuration);
        for (let i = sustainStart; i < data.cursor; i++) {
          const note = data.sortedNotes[i];
          if (note.beat < from && note.beat + note.duration > from) {
            this.schedulePartNote(note, part.id, from, end);
          }
        }
      }

      while (data.cursor < data.sortedNotes.length) {
        const note = data.sortedNotes[data.cursor];
        if (note.beat >= until) break;
        this.schedulePartNote(note, part.id, from, end);
        data.cursor++;
      }
    }
    if (this.metronome) {
      for (let beat = Math.ceil(from - 1e-7); beat < until; beat++) {
        const measure = findMeasure(active.measures, beat);
        const accent = measure && Math.abs(beat - measure.startBeat) < 0.001;
        this.tone(accent ? 96 : 89, 100, this.anchorTime + ((beat - this.anchorBeat) * 60) / this.tempo, 0.025, true);
      }
    }
    this.scheduledUntil = until;
    this.position = now;
    this.callbacks.onPosition?.(this.sourceBeat(now));
  }
  private schedulePartNote(note: ScoreNote, partId: string, from: number, end: number): void {
    const startBeat = Math.max(note.beat, from);
    const stopBeat = Math.min(note.beat + note.duration, end);
    if (stopBeat <= startBeat) return;
    const bank = this.banks.get(this.partInstruments[partId] ?? DEFAULT_INSTRUMENT);
    if (!bank || !this.master) throw new Error('所选本机音色尚未就绪，请重新播放。');
    // Melodic material never becomes an invented drum pattern.
    if (bank.id === 'drums' && note.percussion === undefined) return;
    const midi = bank.id === 'drums' ? note.midi : Math.max(0, Math.min(127, note.midi + this.transpose));
    const source = scheduleInstrumentNote(
      this.context!,
      this.master,
      bank,
      {
        midi,
        velocity: note.velocity,
        legato: note.legato,
        ...(note.percussion !== undefined ? { percussion: note.percussion } : {}),
      },
      this.anchorTime + ((startBeat - this.anchorBeat) * 60) / this.tempo,
      ((stopBeat - startBeat) * 60) / this.tempo,
      ((startBeat - note.beat) * 60) / this.tempo,
    );
    if (!source) return;
    const cleanup = source.onended;
    this.voices.add(source);
    source.onended = (event) => {
      this.voices.delete(source);
      cleanup?.call(source, event);
    };
  }
  pause(): void {
    ++this.generation;
    const beat = this.currentBeat();
    const wasCounting = !!this.counting;
    const wasLoading = this.loading;
    this.playing = false;
    this.loading = false;
    this.counting = undefined;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.silence();
    this.position = Math.min(this.limit(), Math.max(0, beat));
    this.callbacks.onPosition?.(this.sourceBeat(this.position));
    this.callbacks.onState?.(false);
    if (wasCounting) this.callbacks.onCountIn?.(null);
    if (wasLoading) this.callbacks.onAudioState?.('idle', '音色加载已取消，可重新播放。');
  }
  stop(): void {
    this.pause();
    this.position = 0;
    this.callbacks.onPosition?.(0);
  }
  seek(beat: number): void {
    if (this.counting || this.loading) this.pause();
    const safe = Math.min(this.score?.totalBeats || 0, Math.max(0, Number.isFinite(beat) ? beat : 0));
    this.resetSchedule(this.playBeat(safe));
    this.callbacks.onPosition?.(safe);
    if (this.playing) this.tick();
  }
  setTempo(bpm: number): void {
    if (!Number.isFinite(bpm)) return;
    const next = Math.min(400, Math.max(20, bpm));
    if (next === this.tempo) return;
    if (this.counting || this.loading) this.pause();
    const beat = this.currentBeat();
    this.tempo = next;
    this.resetSchedule(beat);
  }
  setTranspose(semitones: number): void {
    if (!Number.isFinite(semitones)) return;
    const next = Math.min(48, Math.max(-48, Math.round(semitones)));
    if (next === this.transpose) return;
    if (this.counting || this.loading) this.pause();
    const beat = this.currentBeat();
    this.transpose = next;
    this.resetSchedule(beat);
  }
  setPartInstruments(map: Record<string, InstrumentId>): void {
    const next: Record<string, InstrumentId> = {};
    for (const part of this.score?.parts ?? []) {
      const id = map[part.id];
      if (isInstrumentId(id) && id !== DEFAULT_INSTRUMENT) next[part.id] = id;
    }
    if (
      Object.keys(next).length === Object.keys(this.partInstruments).length &&
      Object.entries(next).every(([part, id]) => this.partInstruments[part] === id)
    )
      return;
    // Switching sound is explicit and reversible; never resume unexpectedly.
    this.pause();
    this.partInstruments = next;
  }
  setMutedParts(ids: string[]): void {
    const next = new Set(ids);
    if (next.size === this.muted.size && [...next].every((id) => this.muted.has(id))) return;
    const needsBank = this.score?.parts.some(
      (part) =>
        !next.has(part.id) &&
        part.notes.length > 0 &&
        !this.banks.has(this.partInstruments[part.id] ?? DEFAULT_INSTRUMENT),
    );
    if (this.counting || this.loading || (this.playing && needsBank)) this.pause();
    const beat = this.currentBeat();
    this.muted = next;
    this.resetSchedule(beat);
  }
  setLoop(startBeat: number, endBeat: number, enabled: boolean): void {
    const total = this.score?.totalBeats || 0;
    const start = Math.max(0, Math.min(total, Number.isFinite(startBeat) ? startBeat : 0));
    const end = Math.max(start, Math.min(total, Number.isFinite(endBeat) ? endBeat : total));
    const nextEnabled = enabled && end > start;
    if (this.loop.start === start && this.loop.end === end && this.loop.enabled === nextEnabled) return;
    if (this.counting || this.loading) this.pause();
    if (!this.loop.enabled && !nextEnabled) {
      this.loop = { start, end, enabled: false };
      return;
    }
    const now = this.sourceBeat(this.currentBeat());
    this.loop = { start, end, enabled: nextEnabled };
    this.resetSchedule(this.playBeat(this.loop.enabled && (now < start || now >= end) ? start : now));
  }
  setFollowRepeats(enabled: boolean): void {
    if (enabled === this.followRepeats) return;
    if (this.counting || this.loading) this.pause();
    const now = this.sourceBeat(this.currentBeat());
    this.followRepeats = enabled;
    this.resetSchedule(this.playBeat(now));
    this.callbacks.onPosition?.(now);
  }
  setMetronome(enabled: boolean): void {
    if (enabled === this.metronome) return;
    if (this.counting || this.loading) this.pause();
    const now = this.currentBeat();
    this.metronome = enabled;
    this.resetSchedule(now);
  }
  setCountIn(enabled: boolean): void {
    if (enabled === this.countInEnabled) return;
    if (this.counting || this.loading) this.pause();
    this.countInEnabled = enabled;
  }
  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.callbacks = {};
    void this.context?.close();
    this.context = undefined;
    this.master = undefined;
    this.banks.clear();
    this.partInstruments = {};
    this.score = undefined;
    this.performance = undefined;
    this.scoreParts.clear();
    this.performanceParts.clear();
  }
}
