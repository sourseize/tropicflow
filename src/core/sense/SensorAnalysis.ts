/**
 * Runs the pitch and level/onset detectors over audio and turns the results
 * into InputEvents (pitch / level / onset), with change-gating so a stable
 * tone does not flood the log. Used by the live SensorEngine (block by
 * block) and by `analyseBuffer()` for whole files (offline renders, tests).
 */
import { type InputEvent, hzToMidiNote } from '../input/InputEvents.ts';
import { type PitchDetectorOptions, detectPitch, frameSizeFor } from './PitchDetector.ts';
import { LevelOnset, type LevelOnsetOptions, levelToUnit } from './LevelOnset.ts';

export interface SensorOptions {
  pitch?: PitchDetectorOptions;
  level?: LevelOnsetOptions;
  /** Only pitches at least this clear are published. Default 0.8. */
  clarityThreshold?: number;
  /** A pitch is republished when it moved by more than this many cents. Default 3. */
  pitchChangeCents?: number;
  /** A level is republished when it moved by more than this (0..1). Default 0.03. */
  levelChangeUnit?: number;
  /** ...or at least this often (s) while audible. Default 0.25. */
  maxSilentInterval?: number;
}

export const DEFAULT_SENSOR_OPTIONS: Required<Omit<SensorOptions, 'pitch' | 'level'>> = {
  clarityThreshold: 0.8,
  pitchChangeCents: 3,
  levelChangeUnit: 0.03,
  maxSilentInterval: 0.25,
};

/** Raw readings of the latest frame, for the tuner / meter UI. */
export interface SensorReading {
  time: number;
  hz: number | null;
  clarity: number;
  /** 0..1 */
  level: number;
  db: number;
  onset: number | null;
}

/**
 * Stateful event emitter: call `analyseLevel()` per block (short, in order)
 * and `analysePitch()` per frame (longer, overlapping allowed).
 */
export class SensorTracker {
  private readonly opt: Required<Omit<SensorOptions, 'pitch' | 'level'>> & { pitch: PitchDetectorOptions };
  private readonly level: LevelOnset;
  private readonly device: string;
  private lastPitchNote: number | null = null;
  private lastPitchTime: number = -Infinity;
  private lastLevel: number = -1;
  private lastLevelTime: number = -Infinity;
  private reading: SensorReading = { time: 0, hz: null, clarity: 0, level: 0, db: -120, onset: null };

  constructor(device: string, options: SensorOptions = {}) {
    this.device = device;
    this.opt = { ...DEFAULT_SENSOR_OPTIONS, ...options, pitch: options.pitch ?? {} };
    this.level = new LevelOnset(options.level);
  }

  public getReading(): Readonly<SensorReading> {
    return this.reading;
  }

  public reset(): void {
    this.level.reset();
    this.lastPitchNote = null;
    this.lastPitchTime = -Infinity;
    this.lastLevel = -1;
    this.lastLevelTime = -Infinity;
  }

  /** Level/onset for a block starting at `time`. */
  public analyseLevel(block: Float32Array, time: number): InputEvent[] {
    const f = this.level.process(block, time);
    const level = levelToUnit(f.db, this.level.getOptions().floorDb);
    this.reading = { ...this.reading, time, level, db: f.db, onset: f.onset };
    const events: InputEvent[] = [];
    if (f.onset !== null) events.push({ kind: 'onset', time, device: this.device, strength: f.onset });
    const moved = Math.abs(level - this.lastLevel) > this.opt.levelChangeUnit;
    const stale = time - this.lastLevelTime >= this.opt.maxSilentInterval && (level > 0 || this.lastLevel > 0);
    if (moved || stale) {
      this.lastLevel = level;
      this.lastLevelTime = time;
      events.push({ kind: 'level', time, device: this.device, rms: f.rms });
    }
    return events;
  }

  /** Pitch for a frame ending at `time`. */
  public analysePitch(frame: Float32Array, sampleRate: number, time: number): InputEvent[] {
    const est = detectPitch(frame, sampleRate, this.opt.pitch);
    this.reading = { ...this.reading, time, hz: est ? est.hz : null, clarity: est ? est.clarity : 0 };
    if (!est || est.clarity < this.opt.clarityThreshold) {
      this.lastPitchNote = null;
      return [];
    }
    const note = hzToMidiNote(est.hz);
    const moved = this.lastPitchNote === null || Math.abs(note - this.lastPitchNote) * 100 > this.opt.pitchChangeCents;
    const stale = time - this.lastPitchTime >= this.opt.maxSilentInterval;
    if (!moved && !stale) return [];
    this.lastPitchNote = note;
    this.lastPitchTime = time;
    return [{ kind: 'pitch', time, device: this.device, hz: est.hz, clarity: est.clarity }];
  }
}

export interface AnalyseBufferOptions extends SensorOptions {
  /** Samples per level block. Default 256. */
  hop?: number;
  /** Pitch frame length (power of two). Default: frameSizeFor(minHz). */
  frameSize?: number;
  /** Analyse pitch every this many hops. Default 2. */
  pitchEvery?: number;
  device?: string;
}

/** Whole-buffer analysis: the events a live tracker would have produced, times relative to the buffer start. */
export function analyseBuffer(mono: Float32Array, sampleRate: number, options: AnalyseBufferOptions = {}): InputEvent[] {
  const hop = options.hop ?? 256;
  const minHz = options.pitch?.minHz ?? 60;
  const frameSize = options.frameSize ?? frameSizeFor(sampleRate, minHz);
  const pitchEvery = options.pitchEvery ?? 2;
  const tracker = new SensorTracker(options.device ?? 'sensor:file', options);
  const events: InputEvent[] = [];
  let k = 0;
  for (let start = 0; start + hop <= mono.length; start += hop, k++) {
    events.push(...tracker.analyseLevel(mono.subarray(start, start + hop), start / sampleRate));
    const end = start + hop;
    if (k % pitchEvery === 0 && end >= frameSize) {
      events.push(...tracker.analysePitch(mono.subarray(end - frameSize, end), sampleRate, end / sampleRate));
    }
  }
  return events;
}
