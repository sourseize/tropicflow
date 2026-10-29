import { AudioContextManager } from './AudioContextManager';

export type StepCallback = (stepIndex: number, audioTime: number) => void;

export class AudioClock {
  private isRunning: boolean = false;
  private bpm: number = 118;
  private swing: number = 0;
  private currentStep: number = 0;
  private totalSteps: number = 16;
  private nextStepTime: number = 0;
  private timerId: number | null = null;
  private readonly lookaheadMs: number = 25.0;
  private readonly scheduleAheadTime: number = 0.1;
  private readonly stepCallbacks: Set<StepCallback> = new Set();
  private readonly ctxManager: AudioContextManager;

  constructor() {
    this.ctxManager = AudioContextManager.getInstance();
  }

  public subscribe(callback: StepCallback): () => void {
    this.stepCallbacks.add(callback);
    return () => {
      this.stepCallbacks.delete(callback);
    };
  }

  public setBpm(newBpm: number): void {
    this.bpm = Math.max(40, Math.min(240, newBpm));
  }

  public getBpm(): number {
    return this.bpm;
  }

  public setSwing(swingAmount: number): void {
    this.swing = Math.max(0, Math.min(0.5, swingAmount));
  }

  public getSwing(): number {
    return this.swing;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    this.currentStep = 0;
    this.nextStepTime = this.ctxManager.currentTime + 0.05;

    this.timerId = window.setInterval(() => {
      this.scheduler();
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

  private scheduler(): void {
    const ctxTime = this.ctxManager.currentTime;
    while (this.nextStepTime < ctxTime + this.scheduleAheadTime) {
      this.scheduleStep(this.currentStep, this.nextStepTime);
      this.advanceStep();
    }
  }

  private scheduleStep(step: number, time: number): void {
    this.stepCallbacks.forEach((cb) => cb(step, time));
  }

  private advanceStep(): void {
    const secondsPer16th = 60.0 / this.bpm / 4.0;
    let duration = secondsPer16th;
    if (this.currentStep % 2 === 0) {
      duration += secondsPer16th * this.swing;
    } else {
      duration -= secondsPer16th * this.swing;
    }

    this.nextStepTime += duration;
    this.currentStep = (this.currentStep + 1) % this.totalSteps;
  }
}
