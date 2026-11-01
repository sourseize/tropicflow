/**
 * Streaming level and onset detection. Feed consecutive blocks of samples
 * (any length) with their start time; get the block's RMS/dB and, when the
 * level jumps above a slowly falling envelope, an onset with a strength.
 * Pure and stateful; the same class analyses a file offline and the
 * microphone live.
 */

export interface LevelOnsetOptions {
  /** A block must exceed the envelope by this much (dB) to be an onset. Default 8. */
  riseDb?: number;
  /** Blocks quieter than this (dBFS) are never onsets and map to strength 0. Default -45. */
  floorDb?: number;
  /** Minimum time between onsets (s). Default 0.08. */
  refractorySeconds?: number;
  /** How fast the envelope falls after a peak (dB per second). Default 120 (8 dB in 67 ms). */
  releaseDbPerSecond?: number;
}

export const DEFAULT_LEVEL_OPTIONS: Required<LevelOnsetOptions> = {
  riseDb: 8,
  floorDb: -45,
  refractorySeconds: 0.08,
  releaseDbPerSecond: 120,
};

export interface LevelFrame {
  time: number;
  rms: number;
  db: number;
  /** 0..1 when this block starts an onset, else null. */
  onset: number | null;
  /** The envelope the block was compared against (dB). */
  envelopeDb: number;
}

export function rmsToDb(rms: number): number {
  return 20 * Math.log10(rms + 1e-9);
}

/** Level in dBFS mapped onto 0..1 between `floorDb` and 0 dBFS (for LEVEL CV and onset strength). */
export function levelToUnit(db: number, floorDb: number = DEFAULT_LEVEL_OPTIONS.floorDb): number {
  const v = (db - floorDb) / -floorDb;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export class LevelOnset {
  private readonly opt: Required<LevelOnsetOptions>;
  private envelopeDb: number = -120;
  /** The envelope one block ago: a transient starting mid-block must not raise its own baseline. */
  private previousEnvelopeDb: number = -120;
  private lastTime: number | null = null;
  private lastOnsetTime: number = -Infinity;

  constructor(options: LevelOnsetOptions = {}) {
    this.opt = { ...DEFAULT_LEVEL_OPTIONS, ...options };
  }

  public getOptions(): Readonly<Required<LevelOnsetOptions>> {
    return this.opt;
  }

  public reset(): void {
    this.envelopeDb = -120;
    this.previousEnvelopeDb = -120;
    this.lastTime = null;
    this.lastOnsetTime = -Infinity;
  }

  /** Analyse one block starting at `time` (seconds). Blocks are expected in order. */
  public process(block: Float32Array, time: number): LevelFrame {
    let acc = 0;
    let peak = 0;
    for (let i = 0; i < block.length; i++) {
      acc += block[i] * block[i];
      const a = Math.abs(block[i]);
      if (a > peak) peak = a;
    }
    const rms = Math.sqrt(acc / Math.max(1, block.length));
    const db = rmsToDb(rms);

    // Let the envelope fall for the time elapsed since the previous block.
    const dt = this.lastTime === null ? 0 : Math.max(0, time - this.lastTime);
    const fallen = this.envelopeDb - this.opt.releaseDbPerSecond * dt;
    // Baseline: the envelope before the previous block, so a hit that began inside the
    // previous block (raising it) is still judged against the level before the hit.
    const baselineDb = Math.min(fallen, this.previousEnvelopeDb - this.opt.releaseDbPerSecond * dt);
    this.lastTime = time;

    let onset: number | null = null;
    if (db > this.opt.floorDb && db > baselineDb + this.opt.riseDb && time - this.lastOnsetTime >= this.opt.refractorySeconds) {
      // Strength from the peak: a hit that starts late in the block is still a full hit.
      onset = levelToUnit(rmsToDb(peak), this.opt.floorDb);
      this.lastOnsetTime = time;
    }
    this.previousEnvelopeDb = fallen;
    this.envelopeDb = Math.max(db, fallen);
    return { time, rms, db, onset, envelopeDb: baselineDb };
  }
}
