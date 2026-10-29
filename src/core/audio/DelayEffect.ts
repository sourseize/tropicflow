import { AudioContextManager } from './AudioContextManager';

export class DelayEffect {
  public readonly inputNode: GainNode;
  public readonly outputNode: GainNode;
  private readonly delayNode: DelayNode;
  private readonly feedbackNode: GainNode;
  private readonly dampFilter: BiquadFilterNode;
  private readonly ctxManager: AudioContextManager;

  constructor() {
    this.ctxManager = AudioContextManager.getInstance();
    const ctx = this.ctxManager.getContext();

    this.inputNode = ctx.createGain();
    this.outputNode = ctx.createGain();
    this.delayNode = ctx.createDelay(2.0);
    this.feedbackNode = ctx.createGain();
    this.dampFilter = ctx.createBiquadFilter();

    this.dampFilter.type = 'lowpass';
    this.dampFilter.frequency.setValueAtTime(3200, ctx.currentTime);

    this.delayNode.delayTime.setValueAtTime(0.32, ctx.currentTime);
    this.feedbackNode.gain.setValueAtTime(0.38, ctx.currentTime);

    this.inputNode.connect(this.delayNode);
    this.delayNode.connect(this.dampFilter);
    this.dampFilter.connect(this.feedbackNode);
    this.feedbackNode.connect(this.delayNode);
    this.dampFilter.connect(this.outputNode);

    this.outputNode.gain.setValueAtTime(0.4, ctx.currentTime);
  }

  public setDelayTime(seconds: number): void {
    const clamped = Math.max(0.02, Math.min(1.5, seconds));
    const ctx = this.ctxManager.getContext();
    this.delayNode.delayTime.setTargetAtTime(clamped, ctx.currentTime, 0.05);
  }

  public setFeedback(amount: number): void {
    const clamped = Math.max(0, Math.min(0.85, amount));
    const ctx = this.ctxManager.getContext();
    this.feedbackNode.gain.setTargetAtTime(clamped, ctx.currentTime, 0.02);
  }

  public setMix(wetLevel: number): void {
    const clamped = Math.max(0, Math.min(1, wetLevel));
    const ctx = this.ctxManager.getContext();
    this.outputNode.gain.setTargetAtTime(clamped, ctx.currentTime, 0.02);
  }
}
