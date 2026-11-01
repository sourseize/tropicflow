/**
 * Pure-TypeScript audio analysis used to verify rendered audio without
 * listening to it. Runs in Node (tests, CLI) and in the browser.
 *
 *  - verifyScore():    for every scheduled note, measure when the energy in
 *                      that instrument's frequency band actually rises and
 *                      compare with the scheduled time.
 *  - detectOnsets():   blind, full-band onset detector (spurious-hit checks).
 *  - compareBuffers(): numeric similarity between two renders.
 */

import type { ScoreEvent } from '../render/RenderConfig.ts';

export const EPS = 1e-12;

export function toMono(channels: Float32Array[]): Float32Array {
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) {
    for (let i = 0; i < n; i++) out[i] += ch[i];
  }
  const k = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

export function dbFromPower(p: number): number {
  return 10 * Math.log10(p + EPS);
}

export function rms(x: Float32Array, start = 0, end = x.length): number {
  let acc = 0;
  const n = Math.max(0, end - start);
  for (let i = start; i < end; i++) acc += x[i] * x[i];
  return n > 0 ? Math.sqrt(acc / n) : 0;
}

export function peak(x: Float32Array): number {
  let m = 0;
  for (let i = 0; i < x.length; i++) {
    const a = Math.abs(x[i]);
    if (a > m) m = a;
  }
  return m;
}

// ---------------------------------------------------------------------------
// FFT
// ---------------------------------------------------------------------------

/** In-place iterative radix-2 FFT. `re.length` must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if ((n & (n - 1)) !== 0) throw new Error('fft: length must be a power of two');

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j++) {
        const a = i + j;
        const b = a + half;
        const tRe = re[b] * curRe - im[b] * curIm;
        const tIm = re[b] * curIm + im[b] * curRe;
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
      }
    }
  }
}

const hannCache = new Map<number, Float64Array>();
export function hannWindow(n: number): Float64Array {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    hannCache.set(n, w);
  }
  return w;
}

export type WindowType = 'rect' | 'hann';

/**
 * Power spectrum (|X[k]|^2, k = 0..n/2) of the frame starting at `start`.
 * Use a rectangular window for onset timing (a tapered window biases the
 * position of maximum energy rise); use Hann for spectral measurements.
 */
export function powerSpectrum(
  x: Float32Array,
  start: number,
  frameSize: number,
  window: WindowType = 'rect'
): Float64Array {
  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  const w = window === 'hann' ? hannWindow(frameSize) : null;
  for (let i = 0; i < frameSize; i++) {
    const idx = start + i;
    const v = idx >= 0 && idx < x.length ? x[idx] : 0;
    re[i] = w ? v * w[i] : v;
  }
  fft(re, im);
  const half = frameSize / 2;
  const out = new Float64Array(half + 1);
  for (let k = 0; k <= half; k++) out[k] = re[k] * re[k] + im[k] * im[k];
  return out;
}

export interface Band {
  lowHz: number;
  highHz: number;
}

/** Sum of spectral power in [lowHz, highHz] (bins whose centre falls inside, at least one). */
export function bandPower(spectrum: Float64Array, sampleRate: number, frameSize: number, band: Band): number {
  const binHz = sampleRate / frameSize;
  let kLo = Math.floor(band.lowHz / binHz);
  let kHi = Math.ceil(band.highHz / binHz);
  kLo = Math.max(0, kLo);
  kHi = Math.min(spectrum.length - 1, Math.max(kHi, kLo));
  let acc = 0;
  for (let k = kLo; k <= kHi; k++) acc += spectrum[k];
  return acc;
}

export function bandLevelDb(
  x: Float32Array,
  sampleRate: number,
  start: number,
  frameSize: number,
  band: Band,
  window: WindowType = 'rect'
): number {
  return dbFromPower(bandPower(powerSpectrum(x, start, frameSize, window), sampleRate, frameSize, band));
}

// ---------------------------------------------------------------------------
// Score verification
// ---------------------------------------------------------------------------

/** Frequency band in which each instrument's onset is most visible. */
export function bandForEvent(track: string, frequency?: number): Band {
  switch (track) {
    case 'kick':
      return { lowHz: 40, highHz: 160 };
    case 'snare':
      return { lowHz: 1500, highHz: 6000 };
    case 'hihat':
      return { lowHz: 7000, highHz: 11000 };
    case 'marimba':
    case 'synth':
      if (frequency) return { lowHz: frequency / 1.06, highHz: frequency * 1.06 };
      return { lowHz: 120, highHz: 1200 };
    default:
      return { lowHz: 20, highHz: 20000 };
  }
}

export interface StepOnset {
  /** Time (s) of the sharpest full-band energy rise near the expected time. */
  measuredTime: number;
  /** Full-band level rise across that point (dB, 1 ms frames). */
  riseDb: number;
}

export interface StepOnsetOptions {
  searchMs?: number;
  hopMs?: number;
  /** Length of the "after" frame whose level is compared (ms). Default 1. */
  frameMs?: number;
  /**
   * Length of the baseline window immediately before each candidate (ms).
   * Longer than `frameMs` so periodic features of a sustained tail (e.g. a
   * sawtooth edge pinging a resonant filter every cycle) are averaged out
   * rather than mistaken for a quiet moment before an onset. Default 4.
   */
  baselineMs?: number;
  /**
   * Apply a first-difference pre-emphasis (6 dB/oct high-pass tilt) before
   * measuring. Makes transients and hi-hats stand out against sustained
   * low-frequency tails. Default true.
   */
  preEmphasis?: boolean;
}

/** y[n] = x[n] - x[n-1]: cheap high-frequency emphasis for onset detection. */
export function preEmphasize(x: Float32Array): Float32Array {
  const y = new Float32Array(x.length);
  for (let i = 1; i < x.length; i++) y[i] = x[i] - x[i - 1];
  return y;
}

/**
 * Timing check. Near `expectedTime`, find where the full-band level of a
 * short frame (default 1 ms) rises the most relative to the frame before it.
 * Short frames make this sharp (hop 0.25 ms) and the full band avoids any
 * spectral-leakage issues; attributing the hit to an instrument is done
 * separately by `bandRise`.
 */
export function measureStepOnset(
  mono: Float32Array,
  sampleRate: number,
  expectedTime: number,
  options: StepOnsetOptions = {}
): StepOnset {
  const searchMs = options.searchMs ?? 4;
  const hopMs = options.hopMs ?? 0.25;
  const frame = Math.max(2, Math.round(((options.frameMs ?? 1) / 1000) * sampleRate));
  const baseline = Math.max(frame, Math.round(((options.baselineMs ?? 4) / 1000) * sampleRate));
  const signal = options.preEmphasis === false ? mono : preEmphasize(mono);

  const center = Math.round(expectedTime * sampleRate);
  const search = Math.round((searchMs / 1000) * sampleRate);
  const hop = Math.max(1, Math.round((hopMs / 1000) * sampleRate));

  const levelAt = (start: number, length: number) => {
    let acc = 0;
    for (let i = 0; i < length; i++) {
      const idx = start + i;
      const v = idx >= 0 && idx < signal.length ? signal[idx] : 0;
      acc += v * v;
    }
    return dbFromPower(acc / length);
  };

  // Pass 1: levels and rises across the search range.
  const positions: number[] = [];
  const levels: number[] = [];
  const rises: number[] = [];
  let maxLevel = -Infinity;
  for (let pos = center - search; pos <= center + search; pos += hop) {
    const level = levelAt(pos, frame);
    positions.push(pos);
    levels.push(level);
    rises.push(level - levelAt(pos - baseline, baseline));
    if (level > maxLevel) maxLevel = level;
  }

  // Pass 2: the onset is where the rise is sharp *and* the level reaches the
  // loud part of the hit. Scoring rise + (level - peak) rejects smaller
  // pre-onset level changes (e.g. the master compressor's lookahead acting on
  // a sustained tail just before a loud transient) without a hard cutoff
  // that noisy hi-hat fronts can fail.
  let bestPos = center;
  let bestRise = -Infinity;
  let bestScore = -Infinity;
  for (let i = 0; i < positions.length; i++) {
    const score = rises[i] + (levels[i] - maxLevel);
    if (score > bestScore) {
      bestScore = score;
      bestRise = rises[i];
      bestPos = positions[i];
    }
  }
  return { measuredTime: bestPos / sampleRate, riseDb: bestRise };
}

export interface BandRise {
  beforeDb: number;
  afterDb: number;
  riseDb: number;
}

/**
 * Identity check. Compare the Hann-windowed band level in the `windowMs`
 * immediately after `time` with the same window before it.
 */
export function bandRise(
  mono: Float32Array,
  sampleRate: number,
  band: Band,
  time: number,
  windowMs: number = 30
): BandRise {
  let frameSize = 1;
  const want = Math.round((windowMs / 1000) * sampleRate);
  while (frameSize < want) frameSize <<= 1;
  const pos = Math.round(time * sampleRate);
  const beforeDb = bandLevelDb(mono, sampleRate, pos - frameSize, frameSize, band, 'hann');
  const afterDb = bandLevelDb(mono, sampleRate, pos, frameSize, band, 'hann');
  return { beforeDb, afterDb, riseDb: afterDb - beforeDb };
}

export interface ScoreCheck {
  event: ScoreEvent;
  /** Step onset timing error (measured - scheduled) in ms. */
  errorMs: number;
  /** Full-band rise at the step onset (dB). */
  stepRiseDb: number;
  /** Band-limited rise for this instrument (dB). */
  bandRiseDb: number;
  ok: boolean;
  reason?: string;
}

/** Allowed onset error window: measured may be up to `early` ms before or `late` ms after the scheduled time. */
export interface ToleranceWindow {
  early: number;
  late: number;
}

export interface VerifyOptions extends StepOnsetOptions {
  /** Per-track override of the allowed timing window (ms). */
  toleranceMs?: Partial<Record<string, ToleranceWindow>>;
  defaultToleranceMs?: ToleranceWindow;
  /** Minimum full-band rise (dB) at a step to accept that anything hit. */
  minStepRiseDb?: number;
  /** Minimum band rise (dB) to accept that a particular instrument hit. */
  minBandRiseDb?: number;
  /** Per-track override of the identity-check window length (ms). */
  bandWindowMs?: Partial<Record<string, number>>;
  /**
   * Which signal is being analysed: the pre-compressor 'tap' (reference is
   * ScoreEvent.time) or the 'master' output (reference is audibleTime, i.e.
   * time + bus latency). Default 'tap'.
   */
  signal?: 'tap' | 'master';
}

/**
 * Identity-check window per track (ms, rounded up to a power-of-two frame).
 * Short for percussive voices so their front dominates any decaying tail;
 * long for the synth whose energy arrives over a 15 ms attack.
 */
export const DEFAULT_BAND_WINDOW_MS: Record<string, number> = {
  kick: 20,
  snare: 20,
  hihat: 20,
  marimba: 20,
  synth: 40,
};

export interface VerifyResult {
  checks: ScoreCheck[];
  failures: ScoreCheck[];
  maxAbsErrorMs: number;
  meanAbsErrorMs: number;
}

/**
 * Default per-track timing windows (ms) for *in-mix* verification.
 *
 * In a full mix a quiet voice on top of a louder sustained one is inherently
 * ambiguous to locate, so these are deliberately loose (a few ms). For
 * sample-accurate checks render solo stems (RenderConfig.solo) and use
 * `verifyStemOnsets`, whose windows reflect each voice's attack: drums start
 * instantaneously, the marimba has a 3 ms linear attack and the synth a 15 ms
 * exponential attack. Nothing is ever allowed to sound early.
 */
export const DEFAULT_TOLERANCE_MS: Record<string, ToleranceWindow> = {
  kick: { early: 5, late: 5 },
  snare: { early: 5, late: 5 },
  hihat: { early: 5, late: 5 },
  marimba: { early: 5, late: 6 },
  synth: { early: 5, late: 20 },
};

/**
 * Timing windows (ms) for solo stems, see DEFAULT_TOLERANCE_MS. The +-0.6 ms
 * on drums is the precision limit of locating a noise burst's front; the
 * kick is a sine starting at phase 0 so its energy also lags slightly.
 */
export const STEM_TOLERANCE_MS: Record<string, ToleranceWindow> = {
  kick: { early: 0.6, late: 0.75 },
  snare: { early: 0.6, late: 0.75 },
  hihat: { early: 0.6, late: 0.75 },
  marimba: { early: 0.6, late: 5 },
  synth: { early: 0.6, late: 22 },
};

export function verifyScore(
  channels: Float32Array[],
  sampleRate: number,
  score: ScoreEvent[],
  options: VerifyOptions = {}
): VerifyResult {
  const mono = toMono(channels);
  const emphasized = options.preEmphasis === false ? mono : preEmphasize(mono);
  const minStepRiseDb = options.minStepRiseDb ?? 4;
  const minBandRiseDb = options.minBandRiseDb ?? 5;
  const windowFor = (track: string) => options.bandWindowMs?.[track] ?? DEFAULT_BAND_WINDOW_MS[track] ?? 20;
  const fallback = options.defaultToleranceMs ?? { early: 0.75, late: 3 };
  const tolFor = (track: string) => options.toleranceMs?.[track] ?? DEFAULT_TOLERANCE_MS[track] ?? fallback;

  // Group events by reference time so each step's onset is measured once.
  const refTime = (e: ScoreEvent) => (options.signal === 'master' ? e.audibleTime : e.time);
  const byTime = new Map<number, ScoreEvent[]>();
  for (const e of score) {
    const list = byTime.get(refTime(e)) ?? [];
    list.push(e);
    byTime.set(refTime(e), list);
  }

  const checks: ScoreCheck[] = [];
  for (const [time, events] of byTime) {
    const tol = events.map((e) => tolFor(e.track)).reduce(
      (acc, t) => ({ early: Math.min(acc.early, t.early), late: Math.min(acc.late, t.late) }),
      { early: Infinity, late: Infinity }
    );
    const onset = measureStepOnset(emphasized, sampleRate, time, {
      ...options,
      preEmphasis: false,
      searchMs: options.searchMs ?? Math.max(tol.early, tol.late) + 2,
    });
    const errorMs = (onset.measuredTime - time) * 1000;

    for (const event of events) {
      const band = bandForEvent(event.track, event.frequency);
      const br = bandRise(mono, sampleRate, band, time, windowFor(event.track));
      let ok = true;
      let reason: string | undefined;
      if (onset.riseDb < minStepRiseDb) {
        ok = false;
        reason = `no onset: full-band rise ${onset.riseDb.toFixed(1)} dB < ${minStepRiseDb} dB`;
      } else if (errorMs < -tol.early || errorMs > tol.late) {
        ok = false;
        reason = `timing error ${errorMs.toFixed(2)} ms outside [-${tol.early}, +${tol.late}] ms`;
      } else if (br.riseDb < minBandRiseDb) {
        ok = false;
        reason = `${event.track} band ${band.lowHz.toFixed(0)}-${band.highHz.toFixed(0)} Hz rose only ${br.riseDb.toFixed(1)} dB (< ${minBandRiseDb} dB)`;
      }
      checks.push({ event, errorMs, stepRiseDb: onset.riseDb, bandRiseDb: br.riseDb, ok, reason });
    }
  }

  const failures = checks.filter((c) => !c.ok);
  const errs = checks.map((c) => Math.abs(c.errorMs));
  return {
    checks,
    failures,
    maxAbsErrorMs: errs.length ? Math.max(...errs) : 0,
    meanAbsErrorMs: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : 0,
  };
}

// ---------------------------------------------------------------------------
// Blind onset detection (full band, energy based)
// ---------------------------------------------------------------------------

export interface OnsetOptions {
  /** Analysis hop (ms). Default 0.25. */
  hopMs?: number;
  /** Baseline window before a candidate, averaged linearly (ms). Default 20. */
  lookbackMs?: number;
  /** Post window after a candidate, averaged linearly (ms). Default 2. */
  postMs?: number;
  /** Required post/baseline level ratio (dB). Default 10. */
  riseDb?: number;
  /** Ignore anything below this level (dBFS of the post window). Default -60. */
  floorDb?: number;
  /** Minimum spacing between onsets (ms). Default 30 (a 16th at 500 BPM). */
  refractoryMs?: number;
}

/**
 * Blind onset detector (full band, energy based). Returns onset times in
 * seconds.
 *
 * A candidate is where the mean energy of the next `postMs` exceeds the mean
 * energy of the previous `lookbackMs` by `riseDb`. Averaging over whole
 * windows (rather than comparing tiny frames) keeps the periodic dips of a
 * low-frequency tail from registering as onsets. The onset position is then
 * refined to the sharpest 1 ms rise inside the candidate region.
 *
 * Suits percussive/plucked material such as solo stems; overlapping
 * sustained notes in a mix will merge - use verifyScore() for those.
 */
export function detectOnsets(mono: Float32Array, sampleRate: number, options: OnsetOptions = {}): number[] {
  const hop = Math.max(1, Math.round(((options.hopMs ?? 0.25) / 1000) * sampleRate));
  const lookback = Math.max(1, Math.round(((options.lookbackMs ?? 20) / 1000) * sampleRate / hop));
  const post = Math.max(1, Math.round(((options.postMs ?? 2) / 1000) * sampleRate / hop));
  const riseDb = options.riseDb ?? 10;
  const floorDb = options.floorDb ?? -60;
  const refractory = Math.round(((options.refractoryMs ?? 30) / 1000) * sampleRate);
  const oneMs = Math.max(1, Math.round(sampleRate / 1000));

  // Per-hop energy and its prefix sum for O(1) window means.
  const frames = Math.floor(mono.length / hop);
  const prefix = new Float64Array(frames + 1);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    const s = f * hop;
    for (let i = 0; i < hop; i++) acc += mono[s + i] * mono[s + i];
    prefix[f + 1] = prefix[f] + acc / hop;
  }
  const meanEnergy = (from: number, to: number) => (prefix[to] - prefix[from]) / Math.max(1, to - from);

  const energyAt = (start: number, length: number) => {
    let acc = 0;
    for (let i = 0; i < length; i++) {
      const idx = start + i;
      const v = idx >= 0 && idx < mono.length ? mono[idx] : 0;
      acc += v * v;
    }
    return acc / length;
  };

  const onsets: number[] = [];
  let lastOnset = -Infinity;
  for (let f = 0; f + post <= frames; f++) {
    // Before the first full lookback window, whatever exists is the baseline
    // (silence at f = 0), so an onset at t = 0 is detectable.
    const before = meanEnergy(Math.max(0, f - lookback), f);
    const after = meanEnergy(f, f + post);
    if (dbFromPower(after) < floorDb) continue;
    if (dbFromPower(after) - dbFromPower(before) < riseDb) continue;

    // Refine: sharpest 1 ms rise between the candidate and the end of its post window.
    const from = f * hop;
    const to = (f + post) * hop;
    let bestPos = from;
    let bestRise = -Infinity;
    for (let pos = from; pos <= to; pos += hop) {
      const rise = dbFromPower(energyAt(pos, oneMs)) - dbFromPower(energyAt(pos - oneMs, oneMs));
      if (rise > bestRise) {
        bestRise = rise;
        bestPos = pos;
      }
    }
    if (bestPos - lastOnset < refractory) continue;
    onsets.push(bestPos / sampleRate);
    lastOnset = bestPos;
    f += post; // skip the rest of this hit's post window
  }
  return onsets;
}

/** Match detected onsets to expected times; returns unmatched on both sides. */
export function matchOnsets(
  expected: number[],
  detected: number[],
  toleranceSec: number
): { matched: Array<{ expected: number; detected: number }>; missing: number[]; spurious: number[] } {
  const used = new Set<number>();
  const matched: Array<{ expected: number; detected: number }> = [];
  const missing: number[] = [];
  for (const e of expected) {
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < detected.length; i++) {
      if (used.has(i)) continue;
      const d = Math.abs(detected[i] - e);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    if (best >= 0 && bestDist <= toleranceSec) {
      used.add(best);
      matched.push({ expected: e, detected: detected[best] });
    } else {
      missing.push(e);
    }
  }
  const spurious = detected.filter((_, i) => !used.has(i));
  return { matched, missing, spurious };
}

export interface StemCheck {
  event: ScoreEvent;
  /** Measured onset time (s). */
  detected: number;
  errorMs: number;
  riseDb: number;
  ok: boolean;
  reason?: string;
}

export interface StemVerifyResult {
  track: string;
  checks: StemCheck[];
  failures: StemCheck[];
  /** Events that cannot be verified because a louder same-track note sounds within `maskingMs`. */
  masked: StemCheck[];
  /** Blind onsets that are not near any scheduled event of this track. */
  spurious: number[];
  maxAbsErrorMs: number;
}

export interface StemVerifyOptions {
  tolerance?: ToleranceWindow;
  /** Minimum pre-emphasised rise (dB) for an event to count as present. */
  minRiseDb?: number;
  /** A blind onset this close (ms) to a scheduled event is not spurious. */
  spuriousToleranceMs?: number;
  /** A quieter event within this many ms of a louder same-track event is reported as masked, not failed. Default 30. */
  maskingMs?: number;
  /**
   * Blind onsets this many ms after a scheduled event are attributed to its
   * decay (overlapping tails of the same voice can beat and look like an
   * onset) rather than counted as unexpected. Default 150.
   */
  decayMs?: number;
  onset?: OnsetOptions;
  /**
   * Options for the score-guided onset measurement, e.g. a `baselineMs`
   * longer than one period of a sustained low note so its waveform edges
   * are averaged out instead of being taken for the onset. Default 4 ms.
   */
  stepOnset?: StepOnsetOptions;
  signal?: 'tap' | 'master';
}

/**
 * Sample-accurate timing check on a solo stem (one instrument, dry).
 *
 * For every scheduled event of `track` the onset is located by the sharpest
 * pre-emphasised energy rise near the scheduled time (score-guided, so a
 * voice re-hitting on its own decaying tail is still found), and must fall
 * inside the track's timing window. Separately, a blind onset detector must
 * not find hits where nothing was scheduled (outside the decay of any note).
 */
export function verifyStemOnsets(
  channels: Float32Array[],
  sampleRate: number,
  score: ScoreEvent[],
  track: string,
  options: StemVerifyOptions = {}
): StemVerifyResult {
  const tol = options.tolerance ?? STEM_TOLERANCE_MS[track] ?? { early: 0.6, late: 3 };
  // Score-guided + tight timing window => a modest rise at exactly the expected
  // time is strong evidence; 4 dB accepts the weakest jostles on a fresh tail.
  const minRiseDb = options.minRiseDb ?? 4;
  // Blind detection lags by up to ~15 ms when a voice re-hits on its own tail.
  const spuriousTol = (options.spuriousToleranceMs ?? 25) / 1000;
  const masking = (options.maskingMs ?? 30) / 1000;
  const refTime = (e: ScoreEvent) => (options.signal === 'master' ? e.audibleTime : e.time);
  const events = score.filter((e) => e.track === track);
  const mono = toMono(channels);
  const emphasized = preEmphasize(mono);

  const decay = (options.decayMs ?? 150) / 1000;
  // Masked: a louder note within +-masking, or a much louder (>= 2x velocity)
  // note whose decay the event falls into.
  const isMasked = (event: ScoreEvent) =>
    events.some((o) => {
      if (o === event) return false;
      const dt = refTime(event) - refTime(o);
      if (Math.abs(dt) <= masking) {
        return o.velocity > event.velocity || (o.velocity === event.velocity && dt > 0);
      }
      return dt > 0 && dt <= decay && o.velocity >= 2 * event.velocity;
    });

  const checks: StemCheck[] = [];
  const masked: StemCheck[] = [];
  for (const event of events) {
    const t = refTime(event);
    if (isMasked(event)) {
      masked.push({ event, detected: t, errorMs: 0, riseDb: 0, ok: true, reason: 'masked by a louder note nearby' });
      continue;
    }
    // Pre-emphasis sharpens hats/clicks and gives the tightest timing; the
    // raw signal is fairer to a low pitched note landing on a higher one's
    // tail, so fall back to it when the emphasised rise is unconvincing.
    const opts = { ...options.stepOnset, preEmphasis: false, searchMs: Math.max(tol.early, tol.late) + 1 };
    const me = measureStepOnset(emphasized, sampleRate, t, opts);
    const m = me.riseDb >= minRiseDb ? me : measureStepOnset(mono, sampleRate, t, opts);
    const errorMs = (m.measuredTime - t) * 1000;
    let ok = true;
    let reason: string | undefined;
    if (m.riseDb < minRiseDb) {
      ok = false;
      reason = `no onset near ${t.toFixed(4)}s (rise ${m.riseDb.toFixed(1)} dB < ${minRiseDb} dB)`;
    } else if (errorMs < -tol.early || errorMs > tol.late) {
      ok = false;
      reason = `timing error ${errorMs.toFixed(2)} ms outside [-${tol.early}, +${tol.late}] ms`;
    }
    checks.push({ event, detected: m.measuredTime, errorMs, riseDb: m.riseDb, ok, reason });
  }

  // Stems have smooth, monotonically decaying tails, so a modest rise is
  // unambiguous; 6 dB still catches a hit landing on a tail only 125 ms old.
  const detected = detectOnsets(mono, sampleRate, { hopMs: 0.25, riseDb: 6, ...options.onset });
  const spurious = detected.filter(
    (d) => !events.some((e) => Math.abs(refTime(e) - d) <= spuriousTol || (d > refTime(e) && d - refTime(e) <= decay))
  );

  const errs = checks.filter((c) => c.ok).map((c) => Math.abs(c.errorMs));
  return {
    track,
    checks,
    failures: checks.filter((c) => !c.ok),
    masked,
    spurious,
    maxAbsErrorMs: errs.length ? Math.max(...errs) : 0,
  };
}

// ---------------------------------------------------------------------------
// Buffer comparison
// ---------------------------------------------------------------------------

export interface CompareOptions {
  /** Lag search range for cross-correlation, in samples. */
  maxLagSamples?: number;
  /** Window length for the windowed-RMS comparison, in seconds. */
  windowSec?: number;
}

export interface CompareResult {
  lengthA: number;
  lengthB: number;
  identical: boolean;
  maxAbsDiff: number;
  rmsA: number;
  rmsB: number;
  rmsDiff: number;
  /** 20*log10(rmsA / rmsDiff). Infinity when identical. */
  snrDb: number;
  /** Normalised cross-correlation peak in [-1, 1] and the lag (samples) where it occurs. */
  correlation: number;
  /** Positive when B is delayed relative to A (b[i + lag] ~ a[i]). */
  lagSamples: number;
  /** Largest windowed RMS level difference (dB) between the two signals. */
  maxWindowDiffDb: number;
}

export function compareBuffers(a: Float32Array, b: Float32Array, sampleRate: number, options: CompareOptions = {}): CompareResult {
  const n = Math.min(a.length, b.length);
  const maxLag = options.maxLagSamples ?? 0;

  let maxAbsDiff = 0;
  let accA = 0;
  let accB = 0;
  let accD = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    const ad = Math.abs(d);
    if (ad > maxAbsDiff) maxAbsDiff = ad;
    accA += a[i] * a[i];
    accB += b[i] * b[i];
    accD += d * d;
  }
  const rmsA = Math.sqrt(accA / n);
  const rmsB = Math.sqrt(accB / n);
  const rmsDiff = Math.sqrt(accD / n);
  const identical = a.length === b.length && maxAbsDiff === 0;

  // Normalised cross-correlation with a small lag search.
  let bestCorr = -Infinity;
  let bestLag = 0;
  const denom = Math.sqrt(accA * accB) + EPS;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let acc = 0;
    const start = Math.max(0, -lag);
    const end = Math.min(n, n - lag);
    for (let i = start; i < end; i++) acc += a[i] * b[i + lag];
    const c = acc / denom;
    if (c > bestCorr) { bestCorr = c; bestLag = lag || 0; } // `|| 0` normalises -0
  }

  const win = Math.max(1, Math.round((options.windowSec ?? 0.02) * sampleRate));
  let maxWindowDiffDb = 0;
  for (let s = 0; s + win <= n; s += win) {
    const la = dbFromPower(rms(a, s, s + win) ** 2);
    const lb = dbFromPower(rms(b, s, s + win) ** 2);
    if (la < -90 && lb < -90) continue; // both silent
    const d = Math.abs(la - lb);
    if (d > maxWindowDiffDb) maxWindowDiffDb = d;
  }

  return {
    lengthA: a.length,
    lengthB: b.length,
    identical,
    maxAbsDiff,
    rmsA,
    rmsB,
    rmsDiff,
    snrDb: rmsDiff === 0 ? Infinity : 20 * Math.log10(rmsA / rmsDiff),
    correlation: rmsA === 0 && rmsB === 0 ? 1 : bestCorr,
    lagSamples: bestLag,
    maxWindowDiffDb,
  };
}
