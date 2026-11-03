import { disconnectOnEnded } from './AudioContextManager.ts';
import { SeededRandom } from '../util/SeededRandom.ts';

export interface PercussionParams {
  kickTune: number;
  kickDecay: number;
  snareSnap: number;
  snareDecay: number;
  hihatDecay: number;
  volume: number;
}

export const DEFAULT_PERCUSSION_PARAMS: PercussionParams = {
  kickTune: 135,
  kickDecay: 0.38,
  snareSnap: 0.65,
  snareDecay: 0.22,
  hihatDecay: 0.08,
  volume: 0.8,
};

/** Default seed for the shared noise buffer; fixed so renders are reproducible. */
export const DEFAULT_NOISE_SEED = 0x5eed1234;

export class PercussionEngine {
  public readonly outputNode: GainNode;
  private readonly ctx: BaseAudioContext;
  private params: PercussionParams = { ...DEFAULT_PERCUSSION_PARAMS };
  private noiseBuffer: AudioBuffer | null = null;

  constructor(ctx: BaseAudioContext, noiseSeed: number = DEFAULT_NOISE_SEED) {
    this.ctx = ctx;
    this.outputNode = ctx.createGain();
    this.outputNode.gain.setValueAtTime(this.params.volume, ctx.currentTime);
    this.createNoiseBuffer(noiseSeed);
  }

  private createNoiseBuffer(seed: number): void {
    const ctx = this.ctx;
    const bufferSize = Math.floor(ctx.sampleRate * 2);
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    const rng = new SeededRandom(seed);

    for (let i = 0; i < bufferSize; i++) {
      data[i] = rng.bipolar();
    }
    this.noiseBuffer = buffer;
  }

  public updateParam<K extends keyof PercussionParams>(key: K, value: PercussionParams[K]): void {
    this.params[key] = value;
    if (key === 'volume') {
      this.outputNode.gain.setTargetAtTime(value as number, this.ctx.currentTime, 0.02);
    }
  }

  public getParams(): Readonly<PercussionParams> {
    return this.params;
  }

  /**
   * @param when Audio-context time at which the hit should start. Defaults to
   *             "now"; the sequencer passes its lookahead-scheduled time.
   */
  public triggerKick(velocity: number = 0.9, when: number = this.ctx.currentTime): void {
    const ctx = this.ctx;
    const now = Math.max(when, ctx.currentTime);

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.frequency.setValueAtTime(this.params.kickTune, now);
    osc.frequency.exponentialRampToValueAtTime(38, now + 0.08);

    gain.gain.setValueAtTime(velocity * 0.9, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + this.params.kickDecay);

    osc.connect(gain);
    gain.connect(this.outputNode);

    osc.start(now);
    osc.stop(now + this.params.kickDecay);
    disconnectOnEnded(osc, gain);
  }

  public triggerSnare(velocity: number = 0.8, when: number = this.ctx.currentTime): void {
    const ctx = this.ctx;
    const now = Math.max(when, ctx.currentTime);

    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(180, now);
    osc.frequency.exponentialRampToValueAtTime(60, now + 0.1);
    oscGain.gain.setValueAtTime(velocity * 0.45, now);
    oscGain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);

    osc.connect(oscGain);
    oscGain.connect(this.outputNode);
    osc.start(now);
    osc.stop(now + 0.12);
    disconnectOnEnded(osc, oscGain);

    if (this.noiseBuffer) {
      const noise = ctx.createBufferSource();
      noise.buffer = this.noiseBuffer;

      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = 'highpass';
      noiseFilter.frequency.setValueAtTime(950, now);

      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(velocity * this.params.snareSnap * 0.55, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, now + this.params.snareDecay);

      noise.connect(noiseFilter);
      noiseFilter.connect(noiseGain);
      noiseGain.connect(this.outputNode);

      noise.start(now);
      noise.stop(now + this.params.snareDecay);
      disconnectOnEnded(noise, noiseGain, noiseFilter);
    }
  }

  public triggerHiHat(
    velocity: number = 0.7,
    open: boolean = false,
    when: number = this.ctx.currentTime
  ): void {
    if (!this.noiseBuffer) return;
    const ctx = this.ctx;
    const now = Math.max(when, ctx.currentTime);

    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer;

    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.setValueAtTime(8500, now);
    bandpass.Q.setValueAtTime(3.5, now);

    const decayTime = open ? this.params.hihatDecay * 3.5 : this.params.hihatDecay;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(velocity * 0.38, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + decayTime);

    noise.connect(bandpass);
    bandpass.connect(gain);
    gain.connect(this.outputNode);

    noise.start(now);
    noise.stop(now + decayTime);
    disconnectOnEnded(noise, gain, bandpass);
  }

  /** Tear down (one-shot voices release themselves when they end). */
  public dispose(): void {
    this.outputNode.disconnect();
  }
}
