import type { Score } from './types';
import { getPlaybackScore } from './playback';
import { excerptScore } from './excerpt';
import { renderPianoWav } from './piano-wav';
import { INSTRUMENTS, DEFAULT_INSTRUMENT, SUPPORTED_DRUM_NOTES, type InstrumentId } from './instruments';

export type ExportOptions = {
  tempo?: number;
  transpose?: number;
  mutedParts?: string[];
  followRepeats?: boolean;
  measureRange?: { start: number; end: number };
  partInstruments?: Record<string, InstrumentId>;
};

const TICKS_PER_BEAT = 480;

const MELODIC_CHANNELS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15];

function writeVarLen(value: number): number[] {
  let v = Math.max(0, Math.round(value));
  if (!Number.isFinite(v) || v > 0x0fffffff) throw new Error('MIDI 事件间隔超出格式限制，请缩短乐谱。');
  const bytes: number[] = [v & 0x7f];
  while ((v = Math.floor(v / 128)) > 0) {
    bytes.push((v & 0x7f) | 0x80);
  }
  return bytes.reverse();
}

function writeUint32BE(value: number): number[] {
  return [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ];
}

function writeUint16BE(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

type MidiEvent = {
  tick: number;
  order: number;
  data: number[];
};

export function exportMidi(score: Score, options?: ExportOptions): Uint8Array {
  if (options?.measureRange !== undefined) score = excerptScore(score, options.measureRange);
  else if (options?.followRepeats !== false) score = getPlaybackScore(score);
  const tempo = options?.tempo && options.tempo > 0 && Number.isFinite(options.tempo)
    ? options.tempo
    : (score.tempo > 0 && Number.isFinite(score.tempo) ? score.tempo : 120);

  const transpose = options?.transpose && Number.isFinite(options.transpose)
    ? Math.round(options.transpose)
    : 0;

  const mutedSet = new Set(options?.mutedParts ?? []);
  const totalScoreTicks = Math.max(0, Math.round((Number.isFinite(score.totalBeats) ? score.totalBeats : 0) * TICKS_PER_BEAT));

  // Track 0: Conductor Track (Meta events: Track Name, Tempo, End of Track)
  const track0Bytes: number[] = [];
  const titleBytes = new TextEncoder().encode(score.title || 'ScoreCraft');
  track0Bytes.push(0x00, 0xff, 0x03, ...writeVarLen(titleBytes.length), ...titleBytes);

  const usPerBeat = Math.max(1, Math.min(16777215, Math.round(60_000_000 / tempo)));
  track0Bytes.push(0x00, 0xff, 0x51, 0x03, (usPerBeat >>> 16) & 0xff, (usPerBeat >>> 8) & 0xff, usPerBeat & 0xff);

  // Score stores quarter-beat length, not the original meter denominator.
  // Omit 0x58 rather than mislabeling 6/8 as 3/4 or 5/8 as 3/4.
  track0Bytes.push(...writeVarLen(totalScoreTicks), 0xff, 0x2f, 0x00);

  // Track 1..N: One track per part
  const partTracks: number[][] = [];

  type PartConfig = {
    part: (typeof score.parts)[number];
    partIndex: number;
    drums: boolean;
    program: number;
    channel: number;
  };

  const partConfigs: PartConfig[] = [];
  const melodicConfigs: PartConfig[] = [];

  for (let partIndex = 0; partIndex < score.parts.length; partIndex++) {
    const part = score.parts[partIndex];
    const selectedId = options?.partInstruments?.[part.id] ?? DEFAULT_INSTRUMENT;
    const selected = INSTRUMENTS.find(instrument => instrument.id === selectedId);
    if (!selected) throw new Error('未知声部音色，无法导出 MIDI。');

    const drums = selectedId === 'drums';
    const config: PartConfig = {
      part,
      partIndex,
      drums,
      program: selected.midiProgram,
      channel: drums ? 9 : 0,
    };
    partConfigs.push(config);
    if (!drums) {
      melodicConfigs.push(config);
    }
  }

  if (melodicConfigs.length > MELODIC_CHANNELS.length) {
    throw new Error('旋律声部数量超过 15 个通道上限，无法导出 MIDI。');
  }

  for (let i = 0; i < melodicConfigs.length; i++) {
    melodicConfigs[i].channel = MELODIC_CHANNELS[i];
  }

  for (let partIndex = 0; partIndex < partConfigs.length; partIndex++) {
    const config = partConfigs[partIndex];
    const { part, drums, channel, program } = config;
    const trackBytes: number[] = [];

    // Part Name
    const partNameBytes = new TextEncoder().encode(part.name || `Part ${partIndex + 1}`);
    trackBytes.push(0x00, 0xff, 0x03, ...writeVarLen(partNameBytes.length), ...partNameBytes);

    // Program Change
    trackBytes.push(0x00, 0xc0 | channel, program);

    const isMuted = mutedSet.has(part.id);
    const events: MidiEvent[] = [];

    if (!isMuted && Array.isArray(part.notes)) {
      type NoteSpan = {
        startTick: number;
        endTick: number;
        channel: number;
        pitch: number;
        velocity: number;
      };
      const noteSpans: NoteSpan[] = [];

      for (const note of part.notes) {
        if (!Number.isFinite(note.beat) || !Number.isFinite(note.duration) || note.duration <= 0) {
          continue;
        }

        const percussion = note.percussion;
        const drumKey = percussion ?? note.midi;
        if (drums && (percussion === undefined || !(SUPPORTED_DRUM_NOTES as readonly number[]).includes(drumKey))) continue;
        const noteChannel = drums ? 9 : channel;
        const clampedMidi = drums ? drumKey : Math.max(0, Math.min(127, Math.round(note.midi + transpose)));
        const velocity = Math.max(0, Math.min(127, Math.round(Number.isFinite(note.velocity) ? note.velocity : 84)));
        if (velocity === 0) continue; // Do not emit a zero-velocity Note On that could stop a sounding same-pitch note.
        const startTick = Math.max(0, Math.round(note.beat * TICKS_PER_BEAT));
        const durationTicks = Math.max(1, Math.round(note.duration * TICKS_PER_BEAT));
        const endTick = startTick + durationTicks;

        noteSpans.push({
          startTick,
          endTick,
          channel: noteChannel,
          pitch: clampedMidi,
          velocity,
        });
      }

      // Group by channel and pitch to merge overlapping intervals while preserving abutting note boundaries
      const spansByPitch = new Map<string, NoteSpan[]>();
      for (const span of noteSpans) {
        const key = `${span.channel}:${span.pitch}`;
        const list = spansByPitch.get(key);
        if (list) {
          list.push(span);
        } else {
          spansByPitch.set(key, [span]);
        }
      }

      for (const spans of spansByPitch.values()) {
        spans.sort((a, b) => {
          if (a.startTick !== b.startTick) return a.startTick - b.startTick;
          return a.endTick - b.endTick;
        });

        const merged: NoteSpan[] = [];
        for (const span of spans) {
          if (merged.length === 0) {
            merged.push({ ...span });
            continue;
          }
          const last = merged[merged.length - 1];
          if (span.startTick < last.endTick) {
            // Overlapping note: extend duration and keep max velocity, avoiding intermediate NoteOff
            last.endTick = Math.max(last.endTick, span.endTick);
            last.velocity = Math.max(last.velocity, span.velocity);
          } else {
            // Abutting (startTick === last.endTick) or disjoint (startTick > last.endTick):
            // Keep distinct so off-before-on is preserved at the boundary
            merged.push({ ...span });
          }
        }

        for (const span of merged) {
          events.push({
            tick: span.startTick,
            order: 2, // Note On after Note Off at the same tick
            data: [0x90 | span.channel, span.pitch, span.velocity],
          });

          events.push({
            tick: span.endTick,
            order: 1, // Note Off before Note On at the same tick
            data: [0x80 | span.channel, span.pitch, 0],
          });
        }
      }
    }

    events.sort((a, b) => {
      if (a.tick !== b.tick) return a.tick - b.tick;
      return a.order - b.order;
    });

    let lastTick = 0;
    for (const ev of events) {
      const delta = Math.max(0, ev.tick - lastTick);
      trackBytes.push(...writeVarLen(delta), ...ev.data);
      lastTick = ev.tick;
    }

    const endDelta = Math.max(0, Math.max(lastTick, totalScoreTicks) - lastTick);
    trackBytes.push(...writeVarLen(endDelta), 0xff, 0x2f, 0x00);

    partTracks.push(trackBytes);
  }

  const numTracks = 1 + partTracks.length;
  const headerBytes = [
    0x4d, 0x54, 0x68, 0x64, // 'MThd'
    ...writeUint32BE(6),     // header length 6
    ...writeUint16BE(1),     // format 1
    ...writeUint16BE(numTracks),
    ...writeUint16BE(TICKS_PER_BEAT),
  ];

  const tracks = [track0Bytes, ...partTracks];
  const out = new Uint8Array(headerBytes.length + tracks.reduce((sum, track) => sum + 8 + track.length, 0));
  out.set(headerBytes);
  let offset = headerBytes.length;
  for (const trackBytes of tracks) {
    out.set([0x4d, 0x54, 0x72, 0x6b, ...writeUint32BE(trackBytes.length)], offset);
    out.set(trackBytes, offset + 8);
    offset += 8 + trackBytes.length;
  }
  return out;
}

export async function scoreToWav(score: Score, options?: ExportOptions): Promise<Uint8Array> {
  if (options?.measureRange !== undefined) score = excerptScore(score, options.measureRange);
  else if (options?.followRepeats !== false) score = getPlaybackScore(score);
  return renderPianoWav(score, options);
}
