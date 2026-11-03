import type { ModuleFactory, ModuleHost, ModuleInstance } from '../../core/modules/ModuleContract.ts';
import { SensorEngine } from '../../core/sense/SensorEngine.ts';
import { sensorDescriptor } from './descriptor.ts';

export const SENSOR_PITCH_CV = 'sns-pitch-cv';
export const SENSOR_LEVEL_CV = 'sns-level-cv';
export const SENSOR_ONSET_OUT = 'sns-onset-out';

/**
 * Analysers are reused across SENSE instances of a context: Chromium keeps an
 * AnalyserNode alive for ever once something was connected into it, so a
 * fresh one per instance would accumulate with every add / remove.
 */
const analyserPool: WeakMap<BaseAudioContext, AnalyserNode[]> = new WeakMap();
const pool = {
  acquire(ctx: BaseAudioContext): AnalyserNode | null {
    if (typeof ctx.createAnalyser !== 'function') return null;
    const free = analyserPool.get(ctx);
    return free?.pop() ?? ctx.createAnalyser();
  },
  release(node: AnalyserNode): void {
    const ctx = node.context;
    if (!analyserPool.has(ctx)) analyserPool.set(ctx, []);
    analyserPool.get(ctx)!.push(node);
  },
};

/**
 * SENSE: owns the SensorEngine (analyser, microphone stream, virtual voice,
 * ~16 ms poll while active). Its events go to the input bus, where
 * InputBinding turns them into PITCH / LEVEL CV and ONSET TRIG notes.
 * Removing the module releases the microphone, stops the poll and tears the
 * analyser graph down.
 */
export class SensorModule implements ModuleInstance {
  public readonly id: string;
  public readonly descriptor = sensorDescriptor;
  /** Actual ids of this instance's jacks. */
  public readonly ports: Readonly<Record<string, string>>;
  public readonly sensor: SensorEngine;

  constructor(host: ModuleHost, id: string) {
    this.id = id;
    this.ports = Object.fromEntries(this.descriptor.ports.map((p) => [p.id, host.portId(p.id)]));
    this.sensor = new SensorEngine(
      {
        ctx: host.ctx,
        resume: () => host.resume(),
        publish: (events) => host.input.publish(events),
        subscribe: (listener) => host.input.subscribe(listener),
      },
      { analyserPool: pool }
    );
    host.ledger.adopt(this.sensor.inputNode);
  }

  public dispose(): void {
    this.sensor.dispose();
  }
}

export const sensorFactory: ModuleFactory = {
  create: (host, id) => new SensorModule(host, id),
};
