import type { AudioClock } from '../../core/audio/AudioClock.ts';
import type { ModuleFactory, ModuleHost, ModuleInstance, ModuleState } from '../../core/modules/ModuleContract.ts';
import { CLOCK_SWING_CV, CLOCK_TRIG_OUT, clockDescriptor } from './descriptor.ts';

export { CLOCK_SWING_CV, CLOCK_TRIG_OUT };

/**
 * TROPIC CLOCK: exposes the engine's transport to the patch. TRIG OUT is the
 * jack the sequencer's notes are fired from; the swing is published as a
 * 0..1 CV. (The transport itself is engine-owned: tempo, START / STOP and
 * the take recorder work with or without this module in the rack.)
 */
export class ClockModule implements ModuleInstance {
  public readonly id: string;
  public readonly descriptor = clockDescriptor;
  public readonly clock: AudioClock;
  /** Actual ids of this instance's jacks. */
  public readonly trigOut: string;
  public readonly swingCv: string;
  private readonly unsubscribeSwing: () => void;

  constructor(host: ModuleHost, id: string) {
    this.id = id;
    this.clock = host.clock;
    this.trigOut = host.portId(CLOCK_TRIG_OUT);
    this.swingCv = host.portId(CLOCK_SWING_CV);
    // SWING CV out: the clock's swing (0..0.5) as a 0..1 control.
    this.unsubscribeSwing = this.clock.subscribeSwing((swing) => host.setCv(this.swingCv, swing / 0.5, host.ctx.currentTime));
  }

  public getState(): ModuleState {
    return { bpm: this.clock.getBpm(), swing: this.clock.getSwing() };
  }

  public setState(state: ModuleState): void {
    if (typeof state.bpm === 'number') this.clock.setBpm(state.bpm);
    if (typeof state.swing === 'number') this.clock.setSwing(state.swing);
  }

  public dispose(): void {
    this.unsubscribeSwing();
  }
}

export const clockFactory: ModuleFactory = {
  create: (host, id, state) => {
    const m = new ClockModule(host, id);
    if (state) m.setState(state);
    return m;
  },
};
