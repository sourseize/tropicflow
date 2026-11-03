import { type ChamberConfig, ChamberEngine, type ChamberNote } from '../../core/physics/ChamberEngine.ts';
import type { ModuleFactory, ModuleHost, ModuleInstance, ModuleState } from '../../core/modules/ModuleContract.ts';
import { chamberDescriptor } from './descriptor.ts';

export const CHAMBER_TRIG_OUT = 'chm-trig-out';

/**
 * GRAVITY CHAMBER: wraps the ChamberEngine. Notes go to `sink` (the engine
 * decides whether to play or queue them for an offline render), grid
 * quantisation and change notifications come from the host.
 */
export class ChamberModule implements ModuleInstance {
  public readonly id: string;
  public readonly descriptor = chamberDescriptor;
  public readonly engine: ChamberEngine;
  /** Actual id of HIT TRIG on this instance. */
  public readonly trigOut: string;
  /** Receives every note the chamber wants to play; installed by the audio engine. */
  public sink: (note: ChamberNote, module: ChamberModule) => void = () => {};

  constructor(host: ModuleHost, id: string, config: Partial<ChamberConfig> = {}) {
    this.id = id;
    this.trigOut = host.portId(CHAMBER_TRIG_OUT);
    this.engine = new ChamberEngine(config, {
      sink: (note) => this.sink(note, this),
      quantizer: (time, strength) => host.quantizeTime(time, strength),
      onChanged: () => {
        if (host.publishEvents) host.events.publish({ type: 'CHAMBER_CHANGED', timestamp: performance.now() });
      },
    });
  }

  public getState(): ModuleState {
    return { config: this.engine.exportConfig() };
  }

  public setState(state: ModuleState): void {
    if (state.config && typeof state.config === 'object') this.engine.loadConfig(state.config as Partial<ChamberConfig>);
  }

  public onTransportStart(startTime: number): void {
    this.engine.start(startTime);
  }

  public onTransportStop(): void {
    this.engine.stop();
  }

  public dispose(): void {
    this.engine.stop();
    this.sink = () => {};
  }
}

export const chamberFactory: ModuleFactory = {
  create: (host, id, state) => new ChamberModule(host, id, (state?.config as Partial<ChamberConfig> | undefined) ?? {}),
};
