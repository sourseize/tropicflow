/**
 * Maps DOM timestamps (Web MIDI `MIDIMessageEvent.timeStamp`,
 * `KeyboardEvent.timeStamp`: milliseconds since `performance.timeOrigin`) to
 * audio-context seconds, using the (contextTime, performanceTime) pairs that
 * `AudioContext.getOutputTimestamp()` provides.
 *
 * Pure: the adapter feeds samples in; tests feed synthetic ones.
 *
 * Scheduling policy: an event is scheduled at its mapped time plus a fixed
 * latency, never earlier than "now". Constant latency beats minimal latency
 * for playing: the jitter of the main thread is removed, and the engine's
 * score then reflects exactly when the note was meant to sound.
 */

export interface OutputTimestampSample {
  /** Audio-context time of the sample that is leaving the output device. */
  contextTime?: number;
  /** performance.now() at which that was true (milliseconds). */
  performanceTime?: number;
}

/** Latency added to every mapped event (seconds) unless the caller says otherwise. */
export const DEFAULT_INPUT_LATENCY = 0.02;
/**
 * Samples older than this (ms) no longer vote for the offset. Short enough to
 * follow a genuine audio-clock stall (underrun) within a quarter second, long
 * enough (~10 polls) to outvote an isolated stale sample.
 */
export const SAMPLE_WINDOW_MS = 250;
/** A drop of the offset by more than this (s) means the context was suspended: start over. */
export const OFFSET_RESET_DROP = 0.1;

/**
 * The two clocks advance at the same rate, so `contextTime - performanceTime`
 * (the *offset*) is a constant. Measured in Chromium, a busy main thread
 * occasionally gets a *stale* sample (contextTime behind by up to tens of
 * ms), and stale always means a smaller offset. The mapper therefore keeps
 * the samples of a short window and uses the largest offset among them; a
 * sharp drop (context suspended, device changed) clears the window. A real
 * stall of the audio clock (underrun) also lowers the offset; it is adopted
 * once the window has rolled over.
 */
export class TimestampMapper {
  private samples: Array<{ offset: number; performanceTime: number }> = [];
  private latest: { contextTime: number; performanceTime: number } | null = null;
  private readonly windowMs: number;

  constructor(windowMs: number = SAMPLE_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  /**
   * Record a fresh sample. Chromium returns {0, 0} until the context has
   * rendered its first block; such samples (and anything non-finite) are
   * rejected. Returns true when the sample was accepted.
   */
  public update(sample: OutputTimestampSample | undefined | null): boolean {
    if (!sample) return false;
    const { contextTime, performanceTime } = sample;
    if (contextTime === undefined || performanceTime === undefined) return false;
    if (!Number.isFinite(contextTime) || !Number.isFinite(performanceTime)) return false;
    if (performanceTime <= 0) return false;
    const offset = contextTime - performanceTime / 1000;
    const current = this.offset();
    if (current !== null && offset < current - OFFSET_RESET_DROP) this.samples = [];
    this.samples = this.samples.filter((s) => performanceTime - s.performanceTime <= this.windowMs);
    this.samples.push({ offset, performanceTime });
    this.latest = { contextTime, performanceTime };
    return true;
  }

  public hasSample(): boolean {
    return this.samples.length > 0;
  }

  /** The most recent raw sample (diagnostics). */
  public getSample(): { contextTime: number; performanceTime: number } | null {
    return this.latest;
  }

  /** Current estimate of contextTime - performanceTime/1000 (seconds), or null. */
  public offset(): number | null {
    if (this.samples.length === 0) return null;
    let best = -Infinity;
    for (const s of this.samples) if (s.offset > best) best = s.offset;
    return best;
  }

  /** Audio-context time corresponding to a performance.now()-domain timestamp; null before the first sample. */
  public toContextTime(performanceMs: number): number | null {
    const offset = this.offset();
    if (offset === null) return null;
    return performanceMs / 1000 + offset;
  }

  /**
   * When to schedule an event stamped `performanceMs`, given the current
   * context time `now`: mapped time + `latency`, but never before `now`.
   * Without a sample (context not yet running) the event is scheduled at
   * `now` + `latency`.
   */
  public scheduleTime(performanceMs: number, now: number, latency: number = DEFAULT_INPUT_LATENCY): number {
    const mapped = this.toContextTime(performanceMs);
    if (mapped === null) return now + latency;
    return Math.max(now, mapped + latency);
  }
}
