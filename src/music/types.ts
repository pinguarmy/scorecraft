export type ScoreNote = { id: string; partId: string; measure: number; beat: number; duration: number; midi: number; velocity: number; tie?: string; percussion?: number; legato?: boolean };
export type ScorePart = { id: string; name: string; instrument: number; notes: ScoreNote[]; sourcePartId?: string };
export type ScoreMeasure = { number: number; startBeat: number; duration: number };
export type PlaybackSegment = { sourceStart: number; sourceEnd: number; playStart: number };
export type ScorePlayback = { segments: PlaybackSegment[]; totalBeats: number; expanded: boolean };
export type Score = { title: string; composer: string; tempo: number; beatsPerMeasure: number; parts: ScorePart[]; measures: ScoreMeasure[]; totalBeats: number; warnings: string[]; xml: string; playback?: ScorePlayback };
