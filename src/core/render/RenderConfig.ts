import type { NoteSource, Pattern } from '../audio/AudioEngine.ts';
import type { PatchCable } from '../graph/GraphTypes.ts';
import type { SynthParams } from '../audio/OscillatorVoice.ts';
import type { MarimbaParams } from '../audio/MarimbaModel.ts';
import type { PercussionParams } from '../audio/PercussionEngine.ts';
import type { DelayParams } from '../audio/DelayEffect.ts';
import type { ChamberConfig } from '../physics/ChamberEngine.ts';
import type { CollisionEvent } from '../physics/ChamberTypes.ts';
import type { InputScript } from '../input/InputLog.ts';
import type { BridgeSettings, SensorSettings } from '../input/InputBinding.ts';
import type { RackModules } from '../modules/RackPreset.ts';

/**
 * Everything needed to reproduce a render. Serialisable to JSON so the same
 * config can be used by the UI bounce button, the CLI renderer and tests.
 */
export interface RenderConfig {
  bpm: number;
  swing: number;
  bars: number;
  sampleRate: number;
  /** Extra seconds rendered after the last step so tails/delay ring out. */
  tailSeconds: number;
  pattern: Pattern;
  /**
   * The rack to render: modules by type with their ids and states (what
   * BOUNCE captures - two marimbas, no synth, whatever is on the canvas).
   * Omitted = the full studio (every built-in module); the legacy per-module
   * fields below then set their parameters.
   */
  rack?: RackModules;
  /** Cables between the rack's jacks. */
  cables: PatchCable[];
  /**
   * When set, only these tracks are allowed to sound. Used to render solo
   * stems for unambiguous per-instrument timing checks.
   */
  solo?: string[];
  noiseSeed?: number;
  masterVolume?: number;
  /** Legacy per-module parameters (applied to the first module of the type, after the rack's states). */
  synth?: Partial<SynthParams>;
  marimba?: Partial<MarimbaParams>;
  percussion?: Partial<PercussionParams>;
  delay?: Partial<DelayParams>;
  /** Gravity chamber; omitted = disabled. Balls start from the configured state at t = 0. */
  chamber?: Partial<ChamberConfig>;
  /**
   * A performance (MIDI / computer keys / sensor events) replayed through the
   * MIDI BRIDGE with times relative to the first step, so what was played
   * live bounces exactly as heard. See core/input/InputLog.
   */
  inputScript?: InputScript;
  bridge?: Partial<BridgeSettings>;
  /** SENSE module settings (root note for PITCH CV, drum for ONSET TRIG). */
  sensor?: Partial<SensorSettings>;
}

/** One scheduled note in a render - the "score" the WAV should match. */
export interface ScoreEvent {
  /** Scheduled audio-context time of the note-on (seconds). */
  time: number;
  /**
   * Time at which the note becomes audible in the rendered file:
   * `time` + the master bus latency (the DynamicsCompressorNode adds a
   * lookahead delay, ~6 ms in Blink/Gecko/WebKit). Use this for analysis.
   */
  audibleTime: number;
  source: NoteSource;
  /** Sequencer step (sequencer notes only). */
  step?: number;
  track: string;
  frequency?: number;
  velocity: number;
  /** The collision that produced this note (chamber notes only). */
  collision?: CollisionEvent;
}

export interface RenderResult {
  sampleRate: number;
  /** Master output (post compressor) - what the listener hears. */
  channels: Float32Array[];
  /**
   * Pre-compressor tap of the master bus input. Linear and latency-free, so
   * note timing can be verified against `ScoreEvent.time` exactly.
   */
  tapChannels: Float32Array[];
  score: ScoreEvent[];
  /** Time of the last scheduled step + its duration (seconds). */
  patternEnd: number;
  /** Measured master-bus latency (seconds), see ScoreEvent.audibleTime. */
  busLatency: number;
}
