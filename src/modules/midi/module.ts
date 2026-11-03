import type { ModuleFactory, ModuleHost, ModuleInstance } from '../../core/modules/ModuleContract.ts';
import { KeyboardDevice } from '../../core/input/keyboard/KeyboardDevice.ts';
import { WebMidiDevice } from '../../core/input/midi/WebMidiDevice.ts';
import { midiDescriptor } from './descriptor.ts';

export const MIDI_GATE_OUT = 'midi-gate-out';
export const MIDI_PITCH_CV = 'midi-pitch-cv';
export const MIDI_MOD_CV = 'midi-mod-cv';

/**
 * MIDI BRIDGE: owns the computer-keys device and the Web MIDI device. Their
 * events go to the engine's input bus, where InputBinding turns them into
 * notes fired from GATE OUT and into PITCH / MOD CV. Removing the module
 * disables the keys, closes MIDI and releases the timestamp poll. Offline
 * (renders) no device exists: scripts are replayed by the renderer.
 */
export class MidiModule implements ModuleInstance {
  public readonly id: string;
  public readonly descriptor = midiDescriptor;
  /** Actual ids of this instance's jacks. */
  public readonly ports: Readonly<Record<string, string>>;
  public readonly keyboard: KeyboardDevice;
  public readonly midi: WebMidiDevice;
  private readonly releasePoll: () => void;

  constructor(host: ModuleHost, id: string) {
    this.id = id;
    this.ports = Object.fromEntries(this.descriptor.ports.map((p) => [p.id, host.portId(p.id)]));
    const stamp = (ms: number) => host.input.stamp(ms);
    const publish = host.input.publish.bind(host.input);
    this.keyboard = new KeyboardDevice({
      stamp,
      publish,
      listen: (target, type, fn) => host.ledger.listen(target, type, fn),
    });
    this.midi = new WebMidiDevice({ stamp, publish });
    if (host.realtime) {
      this.keyboard.enable();
      this.releasePoll = host.input.acquirePoll();
    } else {
      this.releasePoll = () => {};
    }
  }

  public dispose(): void {
    this.keyboard.disable();
    this.midi.disable();
    this.releasePoll();
  }
}

export const midiFactory: ModuleFactory = {
  create: (host, id) => new MidiModule(host, id),
};
