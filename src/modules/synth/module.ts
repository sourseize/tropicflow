import { OscillatorVoice, type SynthParams } from '../../core/audio/OscillatorVoice.ts';
import type { ModuleFactory, ModuleHost, ModuleInstance, ModuleState, TriggerHandler } from '../../core/modules/ModuleContract.ts';
import { synthDescriptor } from './descriptor.ts';

export const SYNTH_AUDIO_OUT = 'syn-audio-out';
export const SYNTH_GATE_IN = 'syn-gate-in';
export const SYNTH_PITCH_CV = 'syn-pitch-cv';
export const SYNTH_CUTOFF_CV = 'syn-filter-cv';
/** Pitch of a note that carries no frequency (C3). */
const DEFAULT_FREQUENCY = 130.81;
const DEFAULT_DURATION = 0.18;

export class SynthModule implements ModuleInstance {
  public readonly id: string;
  public readonly descriptor = synthDescriptor;
  public readonly voice: OscillatorVoice;
  public readonly audioOutputs: Readonly<Record<string, AudioNode>>;
  public readonly triggerInputs: Readonly<Record<string, TriggerHandler>>;
  private readonly pitchCv: string;
  private readonly cutoffCv: string;

  constructor(host: ModuleHost, id: string) {
    this.id = id;
    this.voice = new OscillatorVoice(host.ctx);
    host.ledger.adopt(this.voice.outputNode);
    this.pitchCv = host.portId(SYNTH_PITCH_CV);
    this.cutoffCv = host.portId(SYNTH_CUTOFF_CV);
    this.audioOutputs = { [host.portId(SYNTH_AUDIO_OUT)]: this.voice.outputNode };
    this.triggerInputs = {
      [host.portId(SYNTH_GATE_IN)]: (cmd, when, extra) => {
        if (cmd.track !== 'synth') return null;
        // New notes are transposed by the PITCH CV (held ones glide, see OscillatorVoice.setPitchOffset).
        const offset = this.voice.getPitchOffset();
        const base = cmd.frequency ?? DEFAULT_FREQUENCY;
        const frequency = offset === 0 ? base : base * Math.pow(2, offset / 12);
        if (extra.holdId !== undefined) {
          this.voice.triggerNote(frequency, cmd.velocity, undefined, when, extra.holdId);
        } else {
          this.voice.triggerNote(frequency, cmd.velocity, cmd.duration ?? DEFAULT_DURATION, when);
        }
        return cmd.frequency === undefined ? cmd : { ...cmd, frequency };
      },
    };
  }

  public setCvTarget(portId: string, value: number, when: number): void {
    if (portId === this.cutoffCv) this.voice.setCutoffModulation(value, when);
    else if (portId === this.pitchCv) this.voice.setPitchOffset(value, when);
  }

  public releaseHeld(holdId: string, when: number): void {
    this.voice.releaseNote(holdId, when);
  }

  public getState(): ModuleState {
    return { ...this.voice.getParams() };
  }

  public setState(state: ModuleState): void {
    for (const [k, v] of Object.entries(state)) this.voice.updateParam(k as keyof SynthParams, v as never);
  }

  public dispose(): void {
    this.voice.dispose();
  }
}

export const synthFactory: ModuleFactory = {
  create: (host, id, state) => {
    const m = new SynthModule(host, id);
    if (state) m.setState(state);
    return m;
  },
};
