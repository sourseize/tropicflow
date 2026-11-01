export type StepCallback = (stepIndex: number, audioTime: number) => void;
/** Called after each scheduling pass with the time everything has been scheduled up to. */
export type HorizonCallback = (horizonTime: number) => void;

export interface ClockOptions {
  /** Returns the current audio-context time in seconds. */
  getTime: () => number;
  bpm?: number;
  swing?: number;
  totalSteps?: number;
}

/**
 * 16th-note step clock.
 *
 * The stepping logic (`advanceUntil`, `advanceSteps`) is pure with respect to
 * wall-clock time: it only consumes audio-context time. The realtime mode
 * (`start`/`stop`) wraps it in a lookahead timer; offline rendering drives it
 * directly with `reset()` + `advanceSteps()`.
 */
export class AudioClock {
  private isRunning: boolean = false;
  private bpm: number = 118;
  private swing: number = 0;
  private currentStep: number = 0;
  private readonly totalSteps: number;
  private nextStepTime: number = 0;
  private startTime: number = 0;
  private timerId: ReturnType<typeof setInterval> | null = null;
  private readonly lookaheadMs: number = 25.0;
  /** How far ahead of the audio clock steps are scheduled (seconds). */
  public readonly scheduleAheadTime: number = 0.1;
  private readonly stepCallbacks: Set<StepCallback> = new Set();
  private readonly horizonCallbacks: Set<HorizonCallback> = new Set();
  private readonly swingCallbacks: Set<(swing: number) => void> = new Set();
  private readonly getTime: () => number;

  constructor(options: ClockOptions) {
    this.getTime = options.getTime;
    this.totalSteps = options.totalSteps ?? 16;
    if (options.bpm !== undefined) this.setBpm(options.bpm);
    if (options.swing !== undefined) this.setSwing(options.swing);
  }

  public subscribe(callback: StepCallback): () => void {
    this.stepCallbacks.add(callback);
    return () => {
      this.stepCallbacks.delete(callback);
    };
  }

  /** Observe the lookahead horizon (continuous processes such as the physics chamber). */
  public subscribeHorizon(callback: HorizonCallback): () => void {
    this.horizonCallbacks.add(callback);
    return () => {
      this.horizonCallbacks.delete(callback);
    };
  }

  public setBpm(newBpm: number): void {
    this.bpm = Math.max(40, Math.min(240, newBpm));
  }

  public getBpm(): number {
    return this.bpm;
  }

  public setSwing(swingAmount: number): void {
    const next = Math.max(0, Math.min(0.5, swingAmount));
    if (next === this.swing) return;
    this.swing = next;
    this.swingCallbacks.forEach((cb) => cb(next));
  }

  /** Observe swing changes (the SWING CV jack publishes them). */
  public subscribeSwing(callback: (swing: number) => void): () => void {
    this.swingCallbacks.add(callback);
    return () => {
      this.swingCallbacks.delete(callback);
    };
  }

  public getSwing(): number {
    return this.swing;
  }

  public getTotalSteps(): number {
    return this.totalSteps;
  }

  public getCurrentStep(): number {
    return this.currentStep;
  }

  public getNextStepTime(): number {
    return this.nextStepTime;
  }

  /** Duration in seconds of a 16th step, including swing for the given step index. */
  public stepDuration(stepIndex: number): number {
    const secondsPer16th = 60.0 / this.bpm / 4.0;
    return stepIndex % 2 === 0
      ? secondsPer16th * (1 + this.swing)
      : secondsPer16th * (1 - this.swing);
  }

  /** Duration of one full pattern cycle (swing pairs cancel out). */
  public patternDuration(): number {
    let total = 0;
    for (let i = 0; i < this.totalSteps; i++) total += this.stepDuration(i);
    return total;
  }

  // ---------------------------------------------------------------------
  // Pure stepping API (used by both realtime and offline drivers)
  // ---------------------------------------------------------------------

  /** Rewind to step 0 with the first step landing at `startTime`. */
  public reset(startTime: number): void {
    this.currentStep = 0;
    this.nextStepTime = startTime;
    this.startTime = startTime;
  }

  /** Fire every step whose time is strictly before `horizonTime`. Returns count fired. */
  public advanceUntil(horizonTime: number): number {
    let fired = 0;
    while (this.nextStepTime < horizonTime) {
      this.fireStep();
      fired++;
    }
    return fired;
  }

  /** Fire exactly `count` steps regardless of time. */
  public advanceSteps(count: number): void {
    for (let i = 0; i < count; i++) this.fireStep();
  }

  /** Notify horizon listeners that everything up to `horizonTime` may be scheduled. */
  public notifyHorizon(horizonTime: number): void {
    this.horizonCallbacks.forEach((cb) => cb(horizonTime));
  }

  /**
   * Snap `time` toward the nearest 16th-step boundary of the running grid.
   * The grid is reconstructed from the actual step times (so it follows BPM
   * and swing changes exactly). `strength` 0 returns `time` unchanged, 1 the
   * grid time; in between interpolates.
   */
  public quantizeTime(time: number, strength: number): number {
    if (strength <= 0) return time;
    let step = this.currentStep;
    let gridTime = this.nextStepTime;
    let guard = 0;
    // Walk back until gridTime <= time ...
    while (gridTime > time && guard++ < 100000) {
      step = (step - 1 + this.totalSteps) % this.totalSteps;
      gridTime -= this.stepDuration(step);
    }
    // ... then forward so that gridTime <= time < nextGrid.
    let nextGrid = gridTime + this.stepDuration(step);
    while (nextGrid <= time && guard++ < 100000) {
      gridTime = nextGrid;
      step = (step + 1) % this.totalSteps;
      nextGrid = gridTime + this.stepDuration(step);
    }
    const nearest = time - gridTime <= nextGrid - time ? gridTime : nextGrid;
    return time + Math.min(1, strength) * (nearest - time);
  }

  private fireStep(): void {
    const step = this.currentStep;
    const time = this.nextStepTime;
    this.stepCallbacks.forEach((cb) => cb(step, time));
    this.nextStepTime += this.stepDuration(step);
    this.currentStep = (step + 1) % this.totalSteps;
  }

  // ---------------------------------------------------------------------
  // Realtime driver
  // ---------------------------------------------------------------------

  /** Time the transport was last started at (first step time). */
  public getStartTime(): number {
    return this.startTime;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.reset(this.getTime() + 0.05);

    this.timerId = setInterval(() => {
      const horizon = this.getTime() + this.scheduleAheadTime;
      this.advanceUntil(horizon);
      this.notifyHorizon(horizon);
    }, this.lookaheadMs);
  }

  public stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.timerId !== null) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this.currentStep = 0;
  }

  public getIsPlaying(): boolean {
    return this.isRunning;
  }
}
