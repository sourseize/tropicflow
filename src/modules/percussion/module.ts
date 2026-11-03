import { DEFAULT_NOISE_SEED, PercussionEngine, type PercussionParams } from '../../core/audio/PercussionEngine.ts';
import type { ModuleFactory, ModuleHost, ModuleInstance, ModuleState, TriggerHandler } from '../../core/modules/ModuleContract.ts';
import { percussionDescriptor } from './descriptor.ts';

export const PERCUSSION_AUDIO_OUT = 'perc-audio-out';
export const PERCUSSION_TRIG_IN = 'perc-trig-in';

export class PercussionModule implements ModuleInstance {
  public readonly id: string;
  public readonly descriptor = percussionDescriptor;
  public readonly drums: PercussionEngine;
  public readonly audioOutputs: Readonly<Record<string, AudioNode>>;
  public readonly triggerInputs: Readonly<Record<string, TriggerHandler>>;
  private readonly noiseSeed: number;

  constructor(host: ModuleHost, id: string, noiseSeed: number = DEFAULT_NOISE_SEED) {
    this.id = id;
    this.noiseSeed = noiseSeed;
    this.drums = new PercussionEngine(host.ctx, noiseSeed);
    host.ledger.adopt(this.drums.outputNode);
    this.audioOutputs = { [host.portId(PERCUSSION_AUDIO_OUT)]: this.drums.outputNode };
    this.triggerInputs = {
      [host.portId(PERCUSSION_TRIG_IN)]: (cmd, when) => {
        switch (cmd.track) {
          case 'kick':
            this.drums.triggerKick(cmd.velocity, when);
            return cmd;
          case 'snare':
            this.drums.triggerSnare(cmd.velocity, when);
            return cmd;
          case 'hihat':
            this.drums.triggerHiHat(cmd.velocity, cmd.open ?? false, when);
            return cmd;
          default:
            return null;
        }
      },
    };
  }

  public getState(): ModuleState {
    return { ...this.drums.getParams(), noiseSeed: this.noiseSeed };
  }

  public setState(state: ModuleState): void {
    for (const [k, v] of Object.entries(state)) {
      if (k !== 'noiseSeed' && typeof v === 'number') this.drums.updateParam(k as keyof PercussionParams, v);
    }
  }

  public dispose(): void {
    this.drums.dispose();
  }
}

export const percussionFactory: ModuleFactory = {
  create: (host, id, state) => {
    const seed = typeof state?.noiseSeed === 'number' ? state.noiseSeed : DEFAULT_NOISE_SEED;
    const m = new PercussionModule(host, id, seed);
    if (state) m.setState(state);
    return m;
  },
};
