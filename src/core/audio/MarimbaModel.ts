import { disconnectOnEnded } from './AudioContextManager.ts';

export interface MarimbaParams {
  brightness: number;
  decay: number;
  bodyTone: number;
  volume: number;
}

export const DEFAULT_MARIMBA_PARAMS: MarimbaParams = {
  brightness: 4.2,
  decay: 0.65,
  bodyTone: 3.5,
  volume: 0.7,
};

export class MarimbaModel {
  public readonly outputNode: GainNode;
  private readonly ctx: BaseAudioContext;
  private params: MarimbaParams = { ...DEFAULT_MARIMBA_PARAMS };

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
    this.outputNode = ctx.createGain();
    this.outputNode.gain.setValueAtTime(this.params.volume, ctx.currentTime);
  }

  public updateParam<K extends keyof MarimbaParams>(key: K, value: MarimbaParams[K]): void {
    this.params[key] = value;
    if (key === 'volume') {
      this.outputNode.gain.setTargetAtTime(value as number, this.ctx.currentTime, 0.02);
    }
  }

  public getParams(): Readonly<MarimbaParams> {
    return this.params;
  }

  /**
   * @param when Audio-context time of the strike (defaults to now).
   */
  public strike(frequency: number, velocity: number = 0.8, when: number = this.ctx.currentTime): void {
    const ctx = this.ctx;
    const now = Math.max(when, ctx.currentTime);

    const carrier = ctx.createOscillator();
    carrier.type = 'sine';
    carrier.frequency.setValueAtTime(frequency, now);

    const modulator = ctx.createOscillator();
    modulator.type = 'triangle';
    modulator.frequency.setValueAtTime(frequency * this.params.bodyTone, now);

    const modGain = ctx.createGain();
    const peakIndex = frequency * this.params.brightness * velocity;
    modGain.gain.setValueAtTime(peakIndex, now);
    modGain.gain.exponentialRampToValueAtTime(0.01, now + 0.04);

    modulator.connect(modGain);
    modGain.connect(carrier.frequency);

    const ampGain = ctx.createGain();
    ampGain.gain.setValueAtTime(0.001, now);
    ampGain.gain.linearRampToValueAtTime(velocity * 0.5, now + 0.003);
    const decayDuration = Math.max(0.1, this.params.decay);
    ampGain.gain.exponentialRampToValueAtTime(0.0001, now + decayDuration);

    carrier.connect(ampGain);
    ampGain.connect(this.outputNode);

    carrier.start(now);
    modulator.start(now);

    const stopTime = now + decayDuration + 0.05;
    carrier.stop(stopTime);
    modulator.stop(stopTime);
    disconnectOnEnded(carrier, ampGain, modGain);
  }
}
