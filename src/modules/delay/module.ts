import { DelayEffect, type DelayParams } from '../../core/audio/DelayEffect.ts';
import type { ModuleFactory, ModuleHost, ModuleInstance, ModuleState } from '../../core/modules/ModuleContract.ts';
import { delayDescriptor } from './descriptor.ts';

export const DELAY_AUDIO_IN = 'del-audio-in';
export const DELAY_WET_OUT = 'del-wet-out';
export const DELAY_TIME_CV = 'del-time-cv';

export class DelayModule implements ModuleInstance {
  public readonly id: string;
  public readonly descriptor = delayDescriptor;
  public readonly effect: DelayEffect;
  public readonly audioInputs: Readonly<Record<string, AudioNode>>;
  public readonly audioOutputs: Readonly<Record<string, AudioNode>>;

  private readonly timeCv: string;

  constructor(host: ModuleHost, id: string) {
    this.id = id;
    this.effect = new DelayEffect(host.ctx);
    host.ledger.adopt(this.effect.inputNode);
    host.ledger.adopt(this.effect.outputNode);
    this.timeCv = host.portId(DELAY_TIME_CV);
    this.audioInputs = { [host.portId(DELAY_AUDIO_IN)]: this.effect.inputNode };
    this.audioOutputs = { [host.portId(DELAY_WET_OUT)]: this.effect.outputNode };
  }

  public setCvTarget(portId: string, value: number, when: number): void {
    if (portId === this.timeCv) this.effect.setTimeModulation(value, when);
  }

  public getState(): ModuleState {
    return { ...this.effect.getParams() };
  }

  public setState(state: ModuleState): void {
    const p = state as Partial<DelayParams>;
    if (typeof p.time === 'number') this.effect.setDelayTime(p.time);
    if (typeof p.feedback === 'number') this.effect.setFeedback(p.feedback);
    if (typeof p.mix === 'number') this.effect.setMix(p.mix);
  }

  public dispose(): void {
    this.effect.dispose();
  }
}

export const delayFactory: ModuleFactory = {
  create: (host, id, state) => {
    const m = new DelayModule(host, id);
    if (state) m.setState(state);
    return m;
  },
};
