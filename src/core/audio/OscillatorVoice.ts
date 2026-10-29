import { AudioContextManager } from './AudioContextManager';

export interface SynthParams {
  waveform: OscillatorType;
  detune: number;
  filterCutoff: number;
  filterResonance: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  volume: number;
}

export const DEFAULT_SYNTH_PARAMS: SynthParams = {
  waveform: 'sawtooth',
  detune: 7,
  filterCutoff: 1800,
  filterResonance: 4.5,
  attack: 0.015,
  decay: 0.25,
  sustain: 0.35,
  release: 0.3,
  volume: 0.6,
};

export class OscillatorVoice {
  public readonly outputNode: GainNode;
  private readonly filterNode: BiquadFilterNode;
  private readonly ctxManager: AudioContextManager;
  private params: SynthParams = { ...DEFAULT_SYNTH_PARAMS };
  private activeVoices: Map<number, { osc1: OscillatorNode; osc2: OscillatorNode; gain: GainNode }> = new Map();

  constructor() {
    this.ctxManager = AudioContextManager.getInstance();
    const ctx = this.ctxManager.getContext();

    this.outputNode = ctx.createGain();
    this.filterNode = ctx.createBiquadFilter();

    this.filterNode.type = 'lowpass';
    this.filterNode.frequency.setValueAtTime(this.params.filterCutoff, ctx.currentTime);
    this.filterNode.Q.setValueAtTime(this.params.filterResonance, ctx.currentTime);

    this.filterNode.connect(this.outputNode);
    this.outputNode.gain.setValueAtTime(this.params.volume, ctx.currentTime);
  }

  public updateParam<K extends keyof SynthParams>(key: K, value: SynthParams[K]): void {
    this.params[key] = value;
    const ctx = this.ctxManager.getContext();

    if (key === 'filterCutoff') {
      this.filterNode.frequency.setTargetAtTime(value as number, ctx.currentTime, 0.02);
    } else if (key === 'filterResonance') {
      this.filterNode.Q.setTargetAtTime(value as number, ctx.currentTime, 0.02);
    } else if (key === 'volume') {
      this.outputNode.gain.setTargetAtTime(value as number, ctx.currentTime, 0.02);
    }
  }

  public getParams(): Readonly<SynthParams> {
    return this.params;
  }

  public triggerNote(frequency: number, velocity: number = 0.8, durationSeconds?: number): void {
    const ctx = this.ctxManager.getContext();
    const now = ctx.currentTime;

    this.releaseNote(frequency);

    const voiceGain = ctx.createGain();
    voiceGain.gain.setValueAtTime(0.0001, now);

    const osc1 = ctx.createOscillator();
    osc1.type = this.params.waveform;
    osc1.frequency.setValueAtTime(frequency, now);

    const osc2 = ctx.createOscillator();
    osc2.type = this.params.waveform;
    osc2.frequency.setValueAtTime(frequency, now);
    osc2.detune.setValueAtTime(this.params.detune, now);

    osc1.connect(voiceGain);
    osc2.connect(voiceGain);
    voiceGain.connect(this.filterNode);

    const attackEnd = now + Math.max(0.002, this.params.attack);
    const decayEnd = attackEnd + Math.max(0.01, this.params.decay);
    const targetGain = velocity * 0.45;
    const sustainGain = targetGain * Math.max(0.05, this.params.sustain);

    voiceGain.gain.exponentialRampToValueAtTime(Math.max(0.001, targetGain), attackEnd);
    voiceGain.gain.exponentialRampToValueAtTime(Math.max(0.0001, sustainGain), decayEnd);

    osc1.start(now);
    osc2.start(now);

    this.activeVoices.set(frequency, { osc1, osc2, gain: voiceGain });

    if (durationSeconds) {
      setTimeout(() => {
        this.releaseNote(frequency);
      }, durationSeconds * 1000);
    }
  }

  public releaseNote(frequency: number): void {
    const voice = this.activeVoices.get(frequency);
    if (!voice) return;

    const ctx = this.ctxManager.getContext();
    const now = ctx.currentTime;
    const releaseTime = Math.max(0.05, this.params.release);

    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
    voice.gain.gain.exponentialRampToValueAtTime(0.00001, now + releaseTime);

    voice.osc1.stop(now + releaseTime);
    voice.osc2.stop(now + releaseTime);

    this.activeVoices.delete(frequency);

    setTimeout(() => {
      try {
        voice.gain.disconnect();
      } catch {
        return;
      }
    }, (releaseTime + 0.1) * 1000);
  }
}
