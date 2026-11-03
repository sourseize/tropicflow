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

/** The scheduled attack/decay of a voice, so its value at any time is known without reading the AudioParam. */
interface Envelope {
  start: number;
  startValue: number;
  attackEnd: number;
  peak: number;
  decayEnd: number;
  sustain: number;
}

interface HeldVoice {
  osc1: OscillatorNode;
  osc2: OscillatorNode;
  gain: GainNode;
  envelope: Envelope;
  /** Pitch offset (semitones) already baked into the note's frequency when it started. */
  startOffset: number;
}

function expInterp(a: number, b: number, f: number): number {
  return a * Math.pow(b / a, Math.max(0, Math.min(1, f)));
}

/** Value of the attack/decay/sustain envelope at `t`. */
export function envelopeValueAt(env: Envelope, t: number): number {
  if (t <= env.start) return env.startValue;
  if (t <= env.attackEnd) return expInterp(env.startValue, env.peak, (t - env.start) / (env.attackEnd - env.start));
  if (t <= env.decayEnd) return expInterp(env.peak, env.sustain, (t - env.attackEnd) / (env.decayEnd - env.attackEnd));
  return env.sustain;
}

export class OscillatorVoice {
  public readonly outputNode: GainNode;
  private readonly filterNode: BiquadFilterNode;
  private readonly ctx: BaseAudioContext;
  private params: SynthParams = { ...DEFAULT_SYNTH_PARAMS };
  /** Only notes without a fixed duration (held keys) are tracked here, by voice id. */
  private heldVoices: Map<string, HeldVoice> = new Map();
  /** CUTOFF CV: octaves added to the filter cutoff. */
  private cutoffModOctaves: number = 0;
  /** PITCH CV: semitones; new notes are transposed by the engine, held notes bend live via detune. */
  private pitchOffset: number = 0;

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
      this.filterNode.frequency.setTargetAtTime(this.effectiveCutoff(), now, 0.02);
    } else if (key === 'filterResonance') {
      this.filterNode.Q.setTargetAtTime(value as number, now, 0.02);
    } else if (key === 'volume') {
      this.outputNode.gain.setTargetAtTime(value as number, now, 0.02);
    }
  }

  public getParams(): Readonly<SynthParams> {
    return this.params;
  }

  /** Cutoff after CV modulation, clamped to the audible/Nyquist-safe range. */
  public effectiveCutoff(): number {
    return Math.max(20, Math.min(this.ctx.sampleRate * 0.45, this.params.filterCutoff * Math.pow(2, this.cutoffModOctaves)));
  }

  /** CUTOFF CV target: octaves added to the cutoff, applied from `when`. */
  public setCutoffModulation(octaves: number, when: number = this.ctx.currentTime): void {
    this.cutoffModOctaves = octaves;
    this.filterNode.frequency.setTargetAtTime(this.effectiveCutoff(), Math.max(when, this.ctx.currentTime), 0.01);
  }

  public getCutoffModulation(): number {
    return this.cutoffModOctaves;
  }

  /**
   * PITCH CV target (semitones). Held notes glide to the new offset relative
   * to the offset they started with; the engine transposes new notes itself
   * (see AudioEngine.playNote) so the score carries the sounding frequency.
   */
  public setPitchOffset(semitones: number, when: number = this.ctx.currentTime): void {
    this.pitchOffset = semitones;
    const t = Math.max(when, this.ctx.currentTime);
    for (const v of this.heldVoices.values()) {
      const cents = (semitones - v.startOffset) * 100;
      v.osc1.detune.setTargetAtTime(cents, t, 0.01);
      v.osc2.detune.setTargetAtTime(this.params.detune + cents, t, 0.01);
    }
  }

  public getPitchOffset(): number {
    return this.pitchOffset;
  }

  /**
   * Trigger a note.
   *
   * With `durationSeconds` the whole envelope (attack, decay, sustain,
   * release, stop) is scheduled up-front on the audio timeline - no timers -
   * so the note is sample-accurate and works in offline rendering.
   * Without a duration the note is held until `releaseNote(voiceId)`.
   *
   * @param when Audio-context time of note-on (defaults to now).
   * @param voiceId Identifies a held note for `releaseNote` (defaults to the
   *   frequency, i.e. mono-per-pitch); retriggering a held id releases it first.
   */
  public triggerNote(
    frequency: number,
    velocity: number = 0.8,
    durationSeconds?: number,
    when: number = this.ctx.currentTime,
    voiceId: string = String(frequency)
  ): void {
    const ctx = this.ctx;
    const now = Math.max(when, ctx.currentTime);

    // Retriggering a held voice releases the previous note first.
    this.releaseNote(voiceId, now);

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
    const envelope: Envelope = {
      start: now,
      startValue: 0.0001,
      attackEnd,
      peak: Math.max(0.001, targetGain),
      decayEnd,
      sustain: Math.max(0.0001, sustainGain),
    };

    voiceGain.gain.exponentialRampToValueAtTime(envelope.peak, attackEnd);
    voiceGain.gain.exponentialRampToValueAtTime(envelope.sustain, decayEnd);

    osc1.start(now);
    osc2.start(now);
    disconnectOnEnded(osc1, voiceGain);

    if (durationSeconds !== undefined) {
      const releaseStart = now + Math.max(0.001, durationSeconds);
      const releaseTime = Math.max(0.05, this.params.release);
      this.release(voiceGain.gain, envelope, releaseStart, releaseTime);
      osc1.stop(releaseStart + releaseTime);
      osc2.stop(releaseStart + releaseTime);
      return;
    }

    this.heldVoices.set(voiceId, { osc1, osc2, gain: voiceGain, envelope, startOffset: this.pitchOffset });
  }

  /** Release a held note by voice id (or frequency). No-op for notes that were triggered with a duration. */
  public releaseNote(voiceId: string | number, when: number = this.ctx.currentTime): void {
    const key = String(voiceId);
    const voice = this.heldVoices.get(key);
    if (!voice) return;

    const now = Math.max(when, this.ctx.currentTime);
    const releaseTime = Math.max(0.05, this.params.release);

    this.release(voice.gain.gain, voice.envelope, now, releaseTime);

    voice.osc1.stop(now + releaseTime);
    voice.osc2.stop(now + releaseTime);

    this.heldVoices.delete(key);
  }

  /** Release every held note (panic / transport stop / device disabled). */
  public releaseAll(when: number = this.ctx.currentTime): void {
    for (const id of Array.from(this.heldVoices.keys())) this.releaseNote(id, when);
  }

  /** Number of notes currently held (tests, UI). */
  public heldCount(): number {
    return this.heldVoices.size;
  }

  /** Ids of the held notes. */
  public heldIds(): string[] {
    return Array.from(this.heldVoices.keys());
  }

  /**
   * Start the release at `at`: ramp down from the envelope's value at that
   * moment. The value is computed from the scheduled envelope rather than
   * read from the AudioParam, and the partial attack/decay up to `at` is
   * re-scheduled explicitly, because `cancelAndHoldAtTime()` scheduled ahead
   * of time (offline renders, pre-scheduled note-offs) does not hold in
   * Chromium: the release ramp then starts from the previous event instead
   * (measured: a sustained note decayed for the whole of its hold).
   */
  private release(param: AudioParam, env: Envelope, at: number, releaseTime: number): void {
    const value = Math.max(0.00001, envelopeValueAt(env, at));
    param.cancelScheduledValues(at);
    // Re-create the segment of the ramp that was cancelled (it is on the same exponential curve).
    param.exponentialRampToValueAtTime(value, at);
    param.exponentialRampToValueAtTime(0.00001, at + releaseTime);
  }

  /** Release every held note and tear the internal graph down. */
  public dispose(): void {
    this.releaseAll(this.ctx.currentTime);
    this.filterNode.disconnect();
    this.outputNode.disconnect();
  }
}
