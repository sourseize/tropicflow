import { disconnectOnEnded } from './AudioContextManager.ts';

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

interface HeldVoice {
  osc1: OscillatorNode;
  osc2: OscillatorNode;
  gain: GainNode;
}

export class OscillatorVoice {
  public readonly outputNode: GainNode;
  private readonly filterNode: BiquadFilterNode;
  private readonly ctx: BaseAudioContext;
  private params: SynthParams = { ...DEFAULT_SYNTH_PARAMS };
  /** Only notes without a fixed duration (e.g. held keyboard keys) are tracked here. */
  private heldVoices: Map<number, HeldVoice> = new Map();

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx;
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
    const now = this.ctx.currentTime;

    if (key === 'filterCutoff') {
      this.filterNode.frequency.setTargetAtTime(value as number, now, 0.02);
    } else if (key === 'filterResonance') {
      this.filterNode.Q.setTargetAtTime(value as number, now, 0.02);
    } else if (key === 'volume') {
      this.outputNode.gain.setTargetAtTime(value as number, now, 0.02);
    }
  }

  public getParams(): Readonly<SynthParams> {
    return this.params;
  }

  /**
   * Trigger a note.
   *
   * With `durationSeconds` the whole envelope (attack, decay, sustain,
   * release, stop) is scheduled up-front on the audio timeline - no timers -
   * so the note is sample-accurate and works in offline rendering.
   * Without a duration the note is held until `releaseNote()`.
   *
   * @param when Audio-context time of note-on (defaults to now).
   */
  public triggerNote(
    frequency: number,
    velocity: number = 0.8,
    durationSeconds?: number,
    when: number = this.ctx.currentTime
  ): void {
    const ctx = this.ctx;
    const now = Math.max(when, ctx.currentTime);

    // Mono-per-pitch behaviour for held notes: retriggering a held pitch releases it.
    this.releaseNote(frequency, now);

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
    disconnectOnEnded(osc1, voiceGain);

    if (durationSeconds !== undefined) {
      const releaseStart = now + Math.max(0.001, durationSeconds);
      const releaseTime = Math.max(0.05, this.params.release);
      // If the release starts mid-attack/decay, hold whatever value the ramp
      // reached, then ramp down.
      this.holdAt(voiceGain.gain, releaseStart);
      voiceGain.gain.exponentialRampToValueAtTime(0.00001, releaseStart + releaseTime);
      osc1.stop(releaseStart + releaseTime);
      osc2.stop(releaseStart + releaseTime);
      return;
    }

    this.heldVoices.set(frequency, { osc1, osc2, gain: voiceGain });
  }

  /** Release a held note. No-op for notes that were triggered with a duration. */
  public releaseNote(frequency: number, when: number = this.ctx.currentTime): void {
    const voice = this.heldVoices.get(frequency);
    if (!voice) return;

    const now = Math.max(when, this.ctx.currentTime);
    const releaseTime = Math.max(0.05, this.params.release);

    this.holdAt(voice.gain.gain, now);
    voice.gain.gain.exponentialRampToValueAtTime(0.00001, now + releaseTime);

    voice.osc1.stop(now + releaseTime);
    voice.osc2.stop(now + releaseTime);

    this.heldVoices.delete(frequency);
  }

  /**
   * Freeze an AudioParam at its automated value at `time` and cancel later
   * automation. Uses cancelAndHoldAtTime where available (Chromium, Safari);
   * falls back to cancel + setValueAtTime(current) otherwise.
   */
  private holdAt(param: AudioParam, time: number): void {
    const p = param as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
    if (typeof p.cancelAndHoldAtTime === 'function') {
      p.cancelAndHoldAtTime(time);
    } else {
      param.cancelScheduledValues(time);
      param.setValueAtTime(Math.max(0.00001, param.value), time);
    }
  }
}
