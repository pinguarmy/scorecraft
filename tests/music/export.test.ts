import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { exportMidi, scoreToWav, type ExportOptions } from '../../src/music/export';
import type { Score } from '../../src/music/types';
import type { InstrumentId } from '../../src/music/instruments';
import { after } from 'node:test';
import { installTestOfflinePcm, TestOfflineContext } from './helpers/offline-pcm';
const restoreOfflinePcm = installTestOfflinePcm();
after(restoreOfflinePcm);

function createMockScore(overrides?: Partial<Score>): Score {
  return {
    title: 'Test Piece',
    composer: 'Test Composer',
    tempo: 120,
    beatsPerMeasure: 4,
    measures: [
      { number: 1, startBeat: 0, duration: 4 },
      { number: 2, startBeat: 4, duration: 4 },
    ],
    totalBeats: 8,
    warnings: [],
    xml: '<score-partwise></score-partwise>',
    parts: [
      {
        id: 'P1-staff1',
        name: 'Piano Treble',
        instrument: 0,
        notes: [
          { id: 'p0-m0-n0', partId: 'P1-staff1', measure: 1, beat: 0, duration: 1, midi: 60, velocity: 80 },
          { id: 'p0-m0-n1', partId: 'P1-staff1', measure: 1, beat: 1, duration: 1, midi: 62, velocity: 80 },
          { id: 'p0-m0-n2', partId: 'P1-staff1', measure: 1, beat: 2, duration: 2, midi: 64, velocity: 80 },
        ],
      },
      {
        id: 'P1-staff2',
        name: 'Piano Bass',
        instrument: 0,
        notes: [
          { id: 'p0-m0-n3', partId: 'P1-staff2', measure: 1, beat: 0, duration: 4, midi: 48, velocity: 70 },
        ],
      },
    ],
    ...overrides,
  };
}

test('zero velocity emits neither MIDI note-on nor note-off and preserves neighboring same-pitch notes and end time', () => {
  const base = createMockScore();
  const score = { ...base, parts: [{ ...base.parts[0], notes: [
    { ...base.parts[0].notes[0], beat: 0, duration: 4, midi: 60, velocity: 80 },
    { ...base.parts[0].notes[0], id: 'silent', beat: 1, duration: 1, midi: 60, velocity: 0 },
    { ...base.parts[0].notes[0], id: 'next', beat: 4, duration: 1, midi: 62, velocity: 90 },
  ] }] };
  const bytes = exportMidi(score); const view = new DataView(bytes.buffer);
  let offset = 14; const notes: number[][] = []; const ends: number[] = []; const programs: number[] = []; let tempos = 0;
  const variable = () => { let n = 0, b; do { b = bytes[offset++]; n = n * 128 + (b & 127); } while (b & 128); return n; };
  for (let track = 0; track < view.getUint16(10); track++) {
    const end = offset + 8 + view.getUint32(offset + 4); offset += 8; let tick = 0;
    while (offset < end) {
      tick += variable(); const status = bytes[offset++];
      if (status === 255) { const meta = bytes[offset++], length = variable(); if (meta === 47) ends.push(tick); if (meta === 81) tempos++; offset += length; }
      else if ((status & 240) === 192) programs.push(bytes[offset++]);
      else { notes.push([tick, status & 240, bytes[offset], bytes[offset + 1]]); offset += 2; }
    }
  }
  assert.deepEqual(notes, [[0, 144, 60, 80], [1920, 128, 60, 0], [1920, 144, 62, 90], [2400, 128, 62, 0]]);
  assert.deepEqual(ends, [3840, 3840]); assert.equal(programs.length, 1); assert.equal(tempos, 1);
});

describe('exportMidi', () => {
  test('creates a valid MIDI format 1 header and chunks', () => {
    const score = createMockScore();
    const midi = exportMidi(score);

    assert.ok(midi instanceof Uint8Array, 'MIDI output should be Uint8Array');
    assert.ok(midi.length > 20, 'MIDI output should have reasonable length');

    // MThd header: 'MThd' (0x4d 0x54 0x68 0x64)
    assert.strictEqual(midi[0], 0x4d);
    assert.strictEqual(midi[1], 0x54);
    assert.strictEqual(midi[2], 0x68);
    assert.strictEqual(midi[3], 0x64);

    const view = new DataView(midi.buffer, midi.byteOffset, midi.byteLength);
    const headerLen = view.getUint32(4);
    assert.strictEqual(headerLen, 6);

    const format = view.getUint16(8);
    assert.strictEqual(format, 1, 'Standard format 1 multi-track MIDI');

    const numTracks = view.getUint16(10);
    // 1 Conductor track + 2 part tracks = 3 tracks
    assert.strictEqual(numTracks, 3);

    const division = view.getUint16(12);
    assert.strictEqual(division, 480);
  });

  test('respects transpose option and clamps to 0-127', () => {
    const score = createMockScore({
      parts: [
        {
          id: 'P1',
          name: 'High Note Part',
          instrument: 0,
          notes: [
            { id: 'n1', partId: 'P1', measure: 1, beat: 0, duration: 1, midi: 125, velocity: 90 },
            { id: 'n2', partId: 'P1', measure: 1, beat: 1, duration: 1, midi: 2, velocity: 90 },
          ],
        },
      ],
    });

    const transposedUp = exportMidi(score, { transpose: 5 });
    // Note 125 + 5 = 130 -> clamped to 127
    // Let's verify bytes contain 127 (0x7F)
    assert.ok(Array.from(transposedUp).includes(127));

    const transposedDown = exportMidi(score, { transpose: -10 });
    // Note 2 - 10 = -8 -> clamped to 0
    assert.ok(Array.from(transposedDown).includes(0));
  });

  test('mutes specified part IDs (including virtual staff parts)', () => {
    const score = createMockScore();
    const mutedMidi = exportMidi(score, { mutedParts: ['P1-staff1'] });

    // P1-staff1 has notes 60, 62, 64. P1-staff2 only has note 48.
    // If P1-staff1 is muted, notes 60, 62, 64 should NOT appear as Note-On (0x90/0x91) events.
    // Let's inspect Note-On events:
    let foundTrebleNotes = false;
    let foundBassNote = false;

    for (let i = 0; i < mutedMidi.length - 2; i++) {
      const status = mutedMidi[i];
      if ((status & 0xf0) === 0x90) {
        const pitch = mutedMidi[i + 1];
        if (pitch === 60 || pitch === 62 || pitch === 64) {
          foundTrebleNotes = true;
        }
        if (pitch === 48) {
          foundBassNote = true;
        }
      }
    }

    assert.strictEqual(foundTrebleNotes, false, 'Muted part notes should not appear in MIDI');
    assert.strictEqual(foundBassNote, true, 'Unmuted part notes should appear in MIDI');
  });

  test('overrides tempo when provided in options', () => {
    const score = createMockScore({ tempo: 100 });
    const midi = exportMidi(score, { tempo: 150 });
    // 150 bpm -> 60_000_000 / 150 = 400,000 us = 0x061A80
    // Meta event Tempo: 0xFF 0x51 0x03 0x06 0x1A 0x80
    let foundTempo = false;
    for (let i = 0; i < midi.length - 5; i++) {
      if (
        midi[i] === 0xff &&
        midi[i + 1] === 0x51 &&
        midi[i + 2] === 0x03 &&
        midi[i + 3] === 0x06 &&
        midi[i + 4] === 0x1a &&
        midi[i + 5] === 0x80
      ) {
        foundTempo = true;
        break;
      }
    }
    assert.ok(foundTempo, 'Custom tempo should be encoded into conductor track');
  });
});

test('large MIDI tracks avoid function argument limits and retain exact note timing', () => {
  const score = createMockScore({ totalBeats: 20000, parts: [{ id: 'big', name: 'big', instrument: 0, notes: Array.from({ length: 20000 }, (_, i) => ({ id: `n${i}`, partId: 'big', measure: 1, beat: i, duration: .5, midi: 60, velocity: 80 })) }] });
  const midi = exportMidi(score);
  const view = new DataView(midi.buffer, midi.byteOffset, midi.byteLength);
  let offset = 14;
  const messages: { tick: number; status: number; data: number[] }[] = [];
  for (let track = 0; track < view.getUint16(10); track++) {
    assert.equal(new TextDecoder().decode(midi.subarray(offset, offset + 4)), 'MTrk');
    const end = offset + 8 + view.getUint32(offset + 4);
    offset += 8; let tick = 0;
    const variable = () => { let n = 0; let b = 0; do { b = midi[offset++]; n = n * 128 + (b & 127); } while (b & 128); return n; };
    while (offset < end) {
      tick += variable(); const status = midi[offset++];
      if (status === 0xff) {
        const type = midi[offset++]; const length = variable();
        assert.notEqual(type, 0x58, 'do not invent meter denominator absent from Score');
        offset += length;
      } else {
        const count = (status & 0xf0) === 0xc0 ? 1 : 2;
        const data = Array.from(midi.subarray(offset, offset + count)); offset += count;
        messages.push({ tick, status, data });
      }
    }
    assert.equal(offset, end);
  }
  const ons = messages.filter(m => (m.status & 0xf0) === 0x90);
  const offs = messages.filter(m => (m.status & 0xf0) === 0x80);
  assert.equal(ons.length, 20000); assert.equal(offs.length, 20000);
  assert.equal(ons[19999].tick, 19999 * 480);
  assert.equal(offs[19999].tick, 19999 * 480 + 240);
  assert.deepEqual(ons[0].data, [60, 80]);
});

describe('scoreToWav', () => {
  test('creates a valid sampled-path PCM16 stereo 44100Hz RIFF WAVE header with test PCM', async () => {
    const score = createMockScore();
    const wav = await scoreToWav(score);

    assert.ok(wav instanceof Uint8Array);
    assert.ok(wav.length > 44, 'WAV file should be larger than 44 bytes');

    // Header checks
    const str = (start: number, len: number) =>
      String.fromCharCode(...wav.slice(start, start + len));

    assert.strictEqual(str(0, 4), 'RIFF');
    assert.strictEqual(str(8, 4), 'WAVE');
    assert.strictEqual(str(12, 4), 'fmt ');
    assert.strictEqual(str(36, 4), 'data');

    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const subchunk1Size = view.getUint32(16, true);
    assert.strictEqual(subchunk1Size, 16);

    const audioFormat = view.getUint16(20, true);
    assert.strictEqual(audioFormat, 1, '1 = PCM');

    const numChannels = view.getUint16(22, true);
    assert.strictEqual(numChannels, 2, 'Stereo');

    const sampleRate = view.getUint32(24, true);
    assert.strictEqual(sampleRate, 44100);

    const byteRate = view.getUint32(28, true);
    assert.strictEqual(byteRate, 44100 * 4);

    const blockAlign = view.getUint16(32, true);
    assert.strictEqual(blockAlign, 4);

    const bitsPerSample = view.getUint16(34, true);
    assert.strictEqual(bitsPerSample, 16);

    const dataSize = view.getUint32(40, true);
    assert.strictEqual(wav.length, 44 + dataSize);
    const context = TestOfflineContext.contexts.at(-1)!;
    assert.equal(context.sources.length, 4, 'uses shared sample BufferSources, not oscillators');
    assert.equal(context.sources[0].at, 0); assert.equal(context.sources[1].at, .5);
    assert.equal(context.sources[0].loop, false);
    let stereoFrames = 0;
    for (let offset = 44; offset < wav.length; offset += 4) {
      if (view.getInt16(offset, true) !== view.getInt16(offset + 2, true)) stereoFrames++;
    }
    assert.ok(stereoFrames > 100, 'test PCM left/right are preserved and interleaved independently');
  });

  test('handles muted parts properly in offline sample scheduling', async () => {
    const score = createMockScore();
    const wavAll = await scoreToWav(score);
    const wavMutedAll = await scoreToWav(score, { mutedParts: ['P1-staff1', 'P1-staff2'] });
    assert.ok(wavAll.subarray(44).some(byte => byte !== 0), 'test PCM bank produces nonzero output');

    assert.ok(wavAll.length > 44);
    assert.ok(wavMutedAll.length > 44);

    // Muted all should be silence
    const view = new DataView(wavMutedAll.buffer, wavMutedAll.byteOffset, wavMutedAll.byteLength);
    let nonZero = 0;
    for (let i = 44; i < wavMutedAll.length; i += 2) {
      if (view.getInt16(i, true) !== 0) {
        nonZero++;
      }
    }
    assert.strictEqual(nonZero, 0, 'Fully muted score should result in silence');
  });

  test('rejects excessive durations before offline context allocation', async () => {
    const excessiveScore = createMockScore({
      tempo: 60,
      totalBeats: 3000, // 3000 beats at 60 bpm = 50 minutes > 20 minutes limit
      parts: [
        {
          id: 'P1',
          name: 'Long part',
          instrument: 0,
          notes: [
            { id: 'n1', partId: 'P1', measure: 1, beat: 0, duration: 2500, midi: 60, velocity: 80 },
          ],
        },
      ],
    });

    const before = TestOfflineContext.created;
    await assert.rejects(
      () => scoreToWav(excessiveScore),
      (err: Error) => {
        assert.ok(err.message.includes('乐谱音频导出时长超过 20 分钟上限'));
        assert.ok(err.message.includes('请缩短乐谱或拆分导出'));
        return true;
      }
    );
    assert.equal(TestOfflineContext.created, before);
  });

  test('256 MiB render-plus-PCM guard rejects before allocation', async () => {
    const before = TestOfflineContext.created;
    await assert.rejects(scoreToWav(createMockScore({ tempo: 60, totalBeats: 600, parts: [] })), /256 MiB/);
    assert.equal(TestOfflineContext.created, before);
  });

  test('missing decoder and failed rendering surface errors without silent substitution, retry can succeed', async () => {
    const old = globalThis.OfflineAudioContext;
    try {
      class MissingDecoder extends TestOfflineContext {
        constructor(channels: number, length: number, rate: number) { super(channels, length, rate); Object.defineProperty(this, 'decodeAudioData', { value: undefined }); }
      }
      globalThis.OfflineAudioContext = MissingDecoder as unknown as typeof OfflineAudioContext;
      await assert.rejects(scoreToWav(createMockScore()), /缺少音频解码器/);
      class FailedRenderer extends TestOfflineContext { async startRendering(): Promise<never> { throw new Error('test render failure'); } }
      globalThis.OfflineAudioContext = FailedRenderer as unknown as typeof OfflineAudioContext;
      await assert.rejects(scoreToWav(createMockScore()), /钢琴 WAV 渲染失败.*test render failure/);
    } finally { globalThis.OfflineAudioContext = old; }
    assert.ok((await scoreToWav(createMockScore())).length > 44);
  });

  test('missing offline audio support rejects explicitly with no synth fallback', async () => {
    const old = globalThis.OfflineAudioContext;
    try {
      globalThis.OfflineAudioContext = undefined as unknown as typeof OfflineAudioContext;
      await assert.rejects(scoreToWav(createMockScore()), /不支持离线音频/);
    } finally { globalThis.OfflineAudioContext = old; }
  });
});

describe('MIDI channel allocation, overlapping voices, and percussion semantics', () => {
  function parseMidiTrackEvents(bytes: Uint8Array) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 14;
    const tracks: { trackIndex: number; events: { tick: number; type: number; channel: number; data: number[] }[] }[] = [];
    const numTracks = view.getUint16(10);
    const variable = () => {
      let n = 0, b = 0;
      do {
        b = bytes[offset++];
        n = n * 128 + (b & 127);
      } while (b & 128);
      return n;
    };
    for (let track = 0; track < numTracks; track++) {
      const end = offset + 8 + view.getUint32(offset + 4);
      offset += 8;
      let tick = 0;
      const trackEvents: { tick: number; type: number; channel: number; data: number[] }[] = [];
      while (offset < end) {
        tick += variable();
        const status = bytes[offset++];
        if (status === 255) {
          offset++;
          const length = variable();
          offset += length;
        } else if ((status & 240) === 192) {
          trackEvents.push({ tick, type: 192, channel: status & 15, data: [bytes[offset++]] });
        } else {
          const type = status & 240;
          const channel = status & 15;
          const d1 = bytes[offset++];
          const d2 = bytes[offset++];
          trackEvents.push({ tick, type, channel, data: [d1, d2] });
        }
      }
      tracks.push({ trackIndex: track, events: trackEvents });
    }
    return tracks;
  }

  test('rejects score when melodic parts exceed 15 channels', () => {
    // 16 melodic parts alternating registered instruments ('piano-bright', 'guitar-acoustic')
    const registeredInstruments: InstrumentId[] = ['piano-bright', 'guitar-acoustic', 'bass-electric', 'strings', 'synth-pad'];
    const parts = Array.from({ length: 16 }, (_, i) => ({
      id: `p${i}`,
      name: `Part ${i}`,
      instrument: 0,
      notes: [{ id: `n${i}`, partId: `p${i}`, measure: 1, beat: 0, duration: 1, midi: 60, velocity: 80 }],
    }));
    const score = createMockScore({ parts });
    const partInstruments: Record<string, InstrumentId> = {};
    for (let i = 0; i < 16; i++) {
      partInstruments[`p${i}`] = registeredInstruments[i % registeredInstruments.length];
    }
    assert.throws(
      () => exportMidi(score, { partInstruments }),
      /超过 15 个通道上限/
    );
  });

  test('rejects score when 16 melodic parts share identical registered instrument without cross-part channel merge', () => {
    // 16 melodic parts all using default piano-bright
    const parts = Array.from({ length: 16 }, (_, i) => ({
      id: `p${i}`,
      name: `Part ${i}`,
      instrument: 0,
      notes: [{ id: `n${i}`, partId: `p${i}`, measure: 1, beat: 0, duration: 1, midi: 60, velocity: 80 }],
    }));
    const score = createMockScore({ parts });
    assert.throws(
      () => exportMidi(score, { partInstruments: Object.fromEntries(parts.map(p => [p.id, 'piano-bright'])) }),
      /超过 15 个通道上限/
    );
  });

  test('allocates independent melodic channels when interleaved with drum parts without premature wrap', () => {
    // 15 melodic parts and 1 drum part (total 16 parts). Drum is placed at index 1.
    const registeredInstruments: InstrumentId[] = ['piano-bright', 'guitar-acoustic', 'bass-electric', 'strings', 'synth-pad'];
    const parts = Array.from({ length: 16 }, (_, i) => {
      if (i === 1) {
        return {
          id: 'drum-part',
          name: 'Drums',
          instrument: 0,
          notes: [{ id: 'dn', partId: 'drum-part', measure: 1, beat: 0, duration: 1, midi: 36, percussion: 36, velocity: 80 }],
        };
      }
      return {
        id: `p${i}`,
        name: `Part ${i}`,
        instrument: 0,
        notes: [{ id: `n${i}`, partId: `p${i}`, measure: 1, beat: 0, duration: 1, midi: 60, velocity: 80 }],
      };
    });
    const score = createMockScore({ parts });
    const partInstruments: Record<string, InstrumentId> = { 'drum-part': 'drums' };
    for (let i = 0; i < 16; i++) {
      if (i !== 1) partInstruments[`p${i}`] = registeredInstruments[i % registeredInstruments.length];
    }

    const midi = exportMidi(score, { partInstruments });
    const tracks = parseMidiTrackEvents(midi);
    // Track 0 is conductor, tracks 1..16 are parts
    assert.equal(tracks.length, 17);

    // Drum track (track 2, index 1 in parts) must be on channel 9
    const drumTrack = tracks[2];
    const drumNote = drumTrack.events.find(e => e.type === 144);
    assert.equal(drumNote?.channel, 9);

    // All 15 melodic tracks must have distinct channels from MELODIC_CHANNELS, no duplicates
    const melodicChannels: number[] = [];
    for (let i = 0; i < 16; i++) {
      if (i === 1) continue;
      const track = tracks[i + 1];
      const noteOn = track.events.find(e => e.type === 144);
      assert.ok(noteOn, `part ${i} should have a Note On event`);
      assert.notEqual(noteOn.channel, 9, `melodic part ${i} must not use drum channel 9`);
      melodicChannels.push(noteOn.channel);
    }
    assert.equal(melodicChannels.length, 15);
    const uniqueChannels = new Set(melodicChannels);
    assert.equal(uniqueChannels.size, 15, 'all 15 melodic parts must receive distinct channels without conflict');
  });

  test('merges overlapping notes of same pitch so intermediate NoteOff does not truncate sustain, keeping off-before-on for abutting notes', () => {
    const score = createMockScore({
      parts: [
        {
          id: 'P1',
          name: 'Polyphonic Part',
          instrument: 0,
          notes: [
            // Voice 1: long note from beat 0 to beat 4 (ticks 0..1920)
            { id: 'v1', partId: 'P1', measure: 1, beat: 0, duration: 4, midi: 60, velocity: 80 },
            // Voice 2: overlapping note from beat 1 to beat 2 (ticks 480..960) on same pitch
            { id: 'v2', partId: 'P1', measure: 1, beat: 1, duration: 1, midi: 60, velocity: 80 },
            // Abutting note: immediately follows Voice 1 from beat 4 to beat 5 (ticks 1920..2400)
            { id: 'v3', partId: 'P1', measure: 1, beat: 4, duration: 1, midi: 60, velocity: 90 },
          ],
        },
      ],
    });

    const midi = exportMidi(score);
    const tracks = parseMidiTrackEvents(midi);
    const partTrack = tracks[1];
    const pitch60Events = partTrack.events.filter(e => e.data[0] === 60 && (e.type === 144 || e.type === 128));

    // There should be NO NoteOff at tick 960 (which would prematurely kill Voice 1)
    const tick960Off = pitch60Events.find(e => e.tick === 960 && e.type === 128);
    assert.equal(tick960Off, undefined, 'intermediate NoteOff at tick 960 must not be emitted to avoid truncating long note');

    // Voice 1 should sustain until tick 1920.
    // At tick 1920, NoteOff must precede NoteOn (off-before-on) to retrigger abutting Voice 3.
    const tick1920Events = pitch60Events.filter(e => e.tick === 1920);
    assert.equal(tick1920Events.length, 2, 'tick 1920 should have both NoteOff and NoteOn');
    assert.equal(tick1920Events[0].type, 128, 'NoteOff must come before NoteOn at tick 1920 (off-before-on)');
    assert.equal(tick1920Events[1].type, 144, 'NoteOn must follow NoteOff at tick 1920');

    // Final NoteOff at tick 2400
    const finalOff = pitch60Events.find(e => e.tick === 2400 && e.type === 128);
    assert.ok(finalOff, 'final NoteOff should occur at tick 2400');
  });

  test('treats percussion on non-drum instruments (piano-warm) as melodic pitch and respects transpose', () => {
    const score = createMockScore({
      parts: [
        {
          id: 'P1',
          name: 'Piano with percussion field',
          instrument: 0,
          notes: [
            { id: 'n1', partId: 'P1', measure: 1, beat: 0, duration: 1, midi: 60, percussion: 36, velocity: 80 },
          ],
        },
      ],
    });

    const midi = exportMidi(score, {
      transpose: 12,
      partInstruments: { P1: 'piano-warm' },
    });
    const tracks = parseMidiTrackEvents(midi);
    const partTrack = tracks[1];
    const noteOn = partTrack.events.find(e => e.type === 144);
    assert.ok(noteOn);

    // Non-drums instrument must use melodic channel (not 9) and apply transpose (60 + 12 = 72)
    assert.notEqual(noteOn.channel, 9, 'piano-warm with percussion note must NOT use drum channel 9');
    assert.equal(noteOn.data[0], 72, 'piano-warm with percussion note must transpose midi (60 + 12 = 72)');
  });
});
