import { MarimbaModel, type MarimbaParams } from '../../core/audio/MarimbaModel.ts';
import type { ModuleFactory, ModuleHost, ModuleInstance, ModuleState, TriggerHandler } from '../../core/modules/ModuleContract.ts';
import { marimbaDescriptor } from './descriptor.ts';

export const MARIMBA_AUDIO_OUT = 'mrm-audio-out';
export const MARIMBA_TRIG_IN = 'mrm-trig-in';
export const MARIMBA_PITCH_CV = 'mrm-cv-in';
/** Pitch of a strike that carries no frequency (C4). */
const DEFAULT_FREQUENCY = 261.63;

export class MarimbaModule implements ModuleInstance {
  public readonly id: string;
  public readonly descriptor = marimbaDescriptor;
  public readonly model: MarimbaModel;
  public readonly audioOutputs: Readonly<Record<string, AudioNode>>;
  public readonly triggerInputs: Readonly<Record<string, TriggerHandler>>;
  private readonly pitchCv: string;
  /** PITCH CV target (semitones), applied per strike: the marimba has no continuous pitch. */
  private pitchSemitones = 0;

  constructor(host: ModuleHost, id: string) {
    this.id = id;
    this.model = new MarimbaModel(host.ctx);
    host.ledger.adopt(this.model.outputNode);
    this.pitchCv = host.portId(MARIMBA_PITCH_CV);
    this.audioOutputs = { [host.portId(MARIMBA_AUDIO_OUT)]: this.model.outputNode };
    this.triggerInputs = {
      [host.portId(MARIMBA_TRIG_IN)]: (cmd, when) => {
        if (cmd.track !== 'marimba') return null;
        const base = cmd.frequency ?? DEFAULT_FREQUENCY;
        const frequency = this.pitchSemitones === 0 ? base : base * Math.pow(2, this.pitchSemitones / 12);
        this.model.strike(frequency, cmd.velocity, when);
        return cmd.frequency === undefined ? cmd : { ...cmd, frequency };
      },
    };
  }

  public setCvTarget(portId: string, value: number): void {
    if (portId === this.pitchCv) this.pitchSemitones = value;
  }

  public getState(): ModuleState {
    return { ...this.model.getParams() };
  }

  public setState(state: ModuleState): void {
    for (const [k, v] of Object.entries(state)) {
      if (typeof v === 'number') this.model.updateParam(k as keyof MarimbaParams, v);
    }
  }

  public dispose(): void {
    this.model.dispose();
  }
}

export const marimbaFactory: ModuleFactory = {
  create: (host, id, state) => {
    const m = new MarimbaModule(host, id);
    if (state) m.setState(state);
    return m;
  },
};
