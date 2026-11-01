/**
 * Monophonic pitch detection on a short frame: YIN (de Cheveigné & Kawahara
 * 2002) - difference function, cumulative mean normalisation, absolute
 * threshold, parabolic interpolation. Pure TypeScript: runs in Node (unit
 * tests, offline analysis of a file) and in the browser (live tracker).
 *
 * `clarity` is 1 - d'(tau) of the chosen lag: close to 1 for a clean
 * periodic signal, low for noise. Consumers gate on it.
 */

export interface PitchDetectorOptions {
  /** Lowest pitch looked for (Hz). Default 60. */
  minHz?: number;
  /** Highest pitch looked for (Hz). Default 1200. */
  maxHz?: number;
  /** YIN absolute threshold on the normalised difference. Default 0.15. */
  threshold?: number;
  /** Frames quieter than this RMS are silence (null). Default 0.0056 (-45 dBFS, the level detector's floor). */
  silenceRms?: number;
}

export interface PitchEstimate {
  hz: number;
  /** 0..1 */
  clarity: number;
  /** Lag in samples (fractional) the estimate came from. */
  tau: number;
  rms: number;
}

export const DEFAULT_PITCH_OPTIONS: Required<PitchDetectorOptions> = {
  minHz: 60,
  maxHz: 1200,
  threshold: 0.15,
  silenceRms: 0.0056,
};

/** Recommended frame length for a given lowest pitch: two periods of `minHz`, rounded up to a power of two. */
export function frameSizeFor(sampleRate: number, minHz: number = DEFAULT_PITCH_OPTIONS.minHz): number {
  const needed = Math.ceil((2 * sampleRate) / minHz);
  let n = 256;
  while (n < needed) n *= 2;
  return n;
}

export function frameRms(frame: Float32Array): number {
  let acc = 0;
  for (let i = 0; i < frame.length; i++) acc += frame[i] * frame[i];
  return Math.sqrt(acc / Math.max(1, frame.length));
}

/**
 * Estimate the pitch of `frame`. Returns null for silence or when no lag in
 * range exists. A frame of N samples resolves pitches down to 2 * sr / N.
 */
export function detectPitch(frame: Float32Array, sampleRate: number, options: PitchDetectorOptions = {}): PitchEstimate | null {
  const opt = { ...DEFAULT_PITCH_OPTIONS, ...options };
  const rms = frameRms(frame);
  if (rms < opt.silenceRms) return null;

  const W = Math.floor(frame.length / 2);
  const tauMin = Math.max(2, Math.floor(sampleRate / opt.maxHz));
  const tauMax = Math.min(W - 1, Math.ceil(sampleRate / opt.minHz));
  if (tauMax <= tauMin) return null;

  // Difference function d(tau) = sum_j (x[j] - x[j + tau])^2 over a window of W samples.
  const d = new Float64Array(tauMax + 1);
  for (let tau = 1; tau <= tauMax; tau++) {
    let acc = 0;
    for (let j = 0; j < W; j++) {
      const diff = frame[j] - frame[j + tau];
      acc += diff * diff;
    }
    d[tau] = acc;
  }

  // Cumulative mean normalised difference d'(tau).
  const dn = new Float64Array(tauMax + 1);
  dn[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    running += d[tau];
    dn[tau] = running > 0 ? (d[tau] * tau) / running : 1;
  }

  // Absolute threshold: the first dip below it, followed to its local minimum.
  let tau = -1;
  for (let t = tauMin; t <= tauMax; t++) {
    if (dn[t] < opt.threshold) {
      while (t + 1 <= tauMax && dn[t + 1] < dn[t]) t++;
      tau = t;
      break;
    }
  }
  // No dip below the threshold: the global minimum, reported with its (low) clarity.
  if (tau < 0) {
    let best = tauMin;
    for (let t = tauMin + 1; t <= tauMax; t++) if (dn[t] < dn[best]) best = t;
    tau = best;
  }

  // Parabolic interpolation around the minimum.
  let refined = tau;
  if (tau > 1 && tau < tauMax) {
    const a = dn[tau - 1];
    const b = dn[tau];
    const c = dn[tau + 1];
    const denom = a - 2 * b + c;
    if (denom > 0) refined = tau + (a - c) / (2 * denom);
  }
  const clarity = Math.max(0, Math.min(1, 1 - dn[tau]));
  return { hz: sampleRate / refined, clarity, tau: refined, rms };
}
