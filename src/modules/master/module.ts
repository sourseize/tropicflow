import type { MasterBus } from '../../core/audio/MasterBus.ts';
import type { ModuleFactory, ModuleHost, ModuleInstance, ModuleState } from '../../core/modules/ModuleContract.ts';
import { masterDescriptor } from './descriptor.ts';

export const MASTER_IN = 'mst-in-l';
export const MASTER_MONITOR = 'mst-monitor';

/**
 * JUNGLE MASTER BUS: the jack into the engine's output stage. Without this
 * module nothing reaches the speakers (or the recorder). The bus itself is
 * engine-owned so the analyser panel and the take recorder keep working.
 */
export class MasterModule implements ModuleInstance {
  public readonly id: string;
  public readonly descriptor = masterDescriptor;
  public readonly bus: MasterBus;
  public readonly audioInputs: Readonly<Record<string, AudioNode>>;
  /** MONITOR is informative (the post-compressor output); it is not a patchable source. */
  public readonly audioOutputs: Readonly<Record<string, AudioNode>> = {};

  constructor(host: ModuleHost, id: string) {
    this.id = id;
    this.bus = host.masterBus;
    this.audioInputs = { [host.portId(MASTER_IN)]: this.bus.inputNode };
  }

  public getState(): ModuleState {
    return { volume: this.bus.getVolume() };
  }

  public setState(state: ModuleState): void {
    if (typeof state.volume === 'number') this.bus.setVolume(state.volume);
  }

  public dispose(): void {}
}

export const masterFactory: ModuleFactory = {
  create: (host, id, state) => {
    const m = new MasterModule(host, id);
    if (state) m.setState(state);
    return m;
  },
};
