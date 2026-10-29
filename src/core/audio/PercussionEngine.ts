import { AudioContextManager } from './AudioContextManager';

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

export class PercussionEngine {
  public readonly outputNode: GainNode;
  private readonly ctxManager: AudioContextManager;
  private params: PercussionParams = { ...DEFAULT_PERCUSSION_PARAMS };
  private noiseBuffer: AudioBuffer | null = null;

  constructor() {
    this.ctxManager = AudioContextManager.getInstance();
    const ctx = this.ctxManager.getContext();

    this.outputNode = ctx.createGain();
    this.outputNode.gain.setValueAtTime(this.params.volume, ctx.currentTime);
    this.createNoiseBuffer();
  }

  private createNoiseBuffer(): void {
    const ctx = this.ctxManager.getContext();
    const bufferSize = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBuffer = buffer;
  }

  public updateParam<K extends keyof PercussionParams>(key: K, value: PercussionParams[K]): void {
    this.params[key] = value;
    if (key === 'volume') {
      const ctx = this.ctxManager.getContext();
      this.outputNode.gain.setTargetAtTime(value as number, ctx.currentTime, 0.02);
    }
  }

  public getParams(): Readonly<PercussionParams> {
    return this.params;
  }

  public triggerKick(velocity: number = 0.9): void {
    const ctx = this.ctxManager.getContext();
    const now = ctx.currentTime;

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

    setTimeout(() => {
      try {
        gain.disconnect();
      } catch {
        return;
      }
    }, (this.params.kickDecay + 0.05) * 1000);
  }

  public triggerSnare(velocity: number = 0.8): void {
    const ctx = this.ctxManager.getContext();
    const now = ctx.currentTime;

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

      setTimeout(() => {
        try {
          noiseGain.disconnect();
          oscGain.disconnect();
        } catch {
          return;
        }
      }, (this.params.snareDecay + 0.05) * 1000);
    }
  }

  public triggerHiHat(velocity: number = 0.7, open: boolean = false): void {
    if (!this.noiseBuffer) return;
    const ctx = this.ctxManager.getContext();
    const now = ctx.currentTime;

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

    setTimeout(() => {
      try {
        gain.disconnect();
      } catch {
        return;
      }
    }, (decayTime + 0.05) * 1000);
  }
}
