export interface DelayParams {
  time: number;
  feedback: number;
  mix: number;
}

export const DEFAULT_DELAY_PARAMS: DelayParams = {
  time: 0.32,
  feedback: 0.38,
  mix: 0.4,
};

export class DelayEffect {
  public readonly inputNode: GainNode;
  public readonly outputNode: GainNode;
  private readonly delayNode: DelayNode;
  private readonly feedbackNode: GainNode;
  private readonly dampFilter: BiquadFilterNode;
  private readonly ctx: BaseAudioContext;
  private params: DelayParams = { ...DEFAULT_DELAY_PARAMS };

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;

    this.inputNode = ctx.createGain();
    this.outputNode = ctx.createGain();
    this.delayNode = ctx.createDelay(2.0);
    this.feedbackNode = ctx.createGain();
    this.dampFilter = ctx.createBiquadFilter();

    this.dampFilter.type = 'lowpass';
    this.dampFilter.frequency.setValueAtTime(3200, ctx.currentTime);

    this.delayNode.delayTime.setValueAtTime(this.params.time, ctx.currentTime);
    this.feedbackNode.gain.setValueAtTime(this.params.feedback, ctx.currentTime);

    this.inputNode.connect(this.delayNode);
    this.delayNode.connect(this.dampFilter);
    this.dampFilter.connect(this.feedbackNode);
    this.feedbackNode.connect(this.delayNode);
    this.dampFilter.connect(this.outputNode);

    this.outputNode.gain.setValueAtTime(this.params.mix, ctx.currentTime);
  }

  public getParams(): Readonly<DelayParams> {
    return this.params;
  }

  public setDelayTime(seconds: number): void {
    this.params.time = Math.max(0.02, Math.min(1.5, seconds));
    this.delayNode.delayTime.setTargetAtTime(this.params.time, this.ctx.currentTime, 0.05);
  }

  public setFeedback(amount: number): void {
    this.params.feedback = Math.max(0, Math.min(0.85, amount));
    this.feedbackNode.gain.setTargetAtTime(this.params.feedback, this.ctx.currentTime, 0.02);
  }

  public setMix(wetLevel: number): void {
    this.params.mix = Math.max(0, Math.min(1, wetLevel));
    this.outputNode.gain.setTargetAtTime(this.params.mix, this.ctx.currentTime, 0.02);
  }
}
