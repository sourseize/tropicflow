/**
 * The plugin contract: what a canvas module is, from the point of view of the
 * engine, the canvas, the renderer and the tests.
 *
 *   ModuleDescriptor  static, cheap, always loaded: identity, look, ports,
 *                     and a `load()` that imports the heavy part on demand.
 *   ModuleFactory     the loaded part: creates instances.
 *   ModuleInstance    a live module in the rack: its AudioNodes per audio
 *                     jack, its trigger / CV handlers, lifecycle, state.
 *   ModuleHost        what the rack gives an instance: the audio context,
 *                     a resource ledger (everything acquired through it is
 *                     counted and released on dispose), and the engine
 *                     services a module may call (notes, CV, clock, events).
 *
 * Nothing here depends on React or the DOM; card bodies are referenced
 * through `ModuleDescriptor.ui` as a lazy component loader.
 *
 * See docs/PLUGIN_ARCHITECTURE_PLAN.md.
 */
import type { CvSourceKind, CvTargetKind, ModulePort, PortType } from '../graph/GraphTypes.ts';
import type { NoteCommand } from '../physics/CollisionMapper.ts';
import type { CollisionEvent } from '../physics/ChamberTypes.ts';
import type { EventBus } from '../events/EventBus.ts';
import type { AudioClock } from '../audio/AudioClock.ts';
import type { MasterBus } from '../audio/MasterBus.ts';
import type { InputEvent } from '../input/InputEvents.ts';
import type { ResourceCounts, ResourceLedger } from './ResourceLedger.ts';

export type ModuleTheme = 'mango' | 'tomato' | 'lime' | 'papaya';

/**
 * A jack as declared by a descriptor. `direction` follows from `type`. The
 * spec id is the jack's id on the canonical instance of the type
 * (`<type>-1`); further instances get `<spec id>@<instance id>` (see
 * `portIdFor`), so the ids of the default rack never change.
 */
export interface ModulePortSpec {
  id: string;
  name: string;
  type: PortType;
  color: string;
  /** CV jacks declare how their value is interpreted (see core/cv/CvBus). */
  cvKind?: CvSourceKind | CvTargetKind;
  /** Trigger-out jacks: how notes fired from here are labelled in scores. */
  noteSource?: NoteSource;
}

/** Actual id of a jack on an instance (canonical instance keeps the spec id). */
export function portIdFor(type: string, instanceId: string, specId: string): string {
  return instanceId === `${type}-1` ? specId : `${specId}@${instanceId}`;
}

export interface ModuleDescriptor {
  /** Unique type id, e.g. 'marimba'. Also the card's badge. */
  type: string;
  title: string;
  /** One line for the module browser. */
  description: string;
  theme: ModuleTheme;
  accentHex: string;
  /** Rendered card width in px (the canvas needs it for layouts). */
  cardWidthPx: number;
  ports: ModulePortSpec[];
  /**
   * The engine part: returned directly when statically imported, or as a
   * promise from a dynamic `import()` (code-split). Cached by the registry.
   */
  load: () => ModuleFactory | Promise<ModuleFactory>;
  /**
   * Import the card body (code-split). Optional: built-ins register theirs
   * on the UI side instead (src/modules/cards.ts) so the engine and the
   * headless harness never load React; a module without a body shows only
   * its jacks. Typed loosely so the core stays free of React.
   */
  ui?: () => Promise<{ default: unknown }>;
}

/**
 * Who asked for a note, as labelled in scores: the clock ('sequencer'), the
 * chamber, the MIDI BRIDGE ('midi') or the SENSE module ('sensor'). New
 * plugins may label their trigger-out jacks freely.
 */
export type NoteSource = 'sequencer' | 'chamber' | 'midi' | 'sensor' | (string & {});

export interface NoteExtra {
  step?: number;
  collision?: CollisionEvent;
  /** Hold the note until `releaseHeld(holdId)` instead of using `cmd.duration`. */
  holdId?: string;
}

/**
 * The input bus as seen by a module that owns devices (keys, MIDI, a
 * microphone): stamp a DOM timestamp onto the audio timeline, publish
 * InputEvents (they are logged, replayed and bounced like any other), listen
 * to the bus, and keep the realtime timestamp poll alive while needed.
 */
export interface InputService {
  stamp(performanceMs: number): number;
  publish(events: InputEvent[]): void;
  subscribe(listener: (event: InputEvent) => void): () => void;
  /** Hold the output-timestamp poll (devices need fresh samples); call the result to release. */
  acquirePoll(): () => void;
}

/** Engine services an instance may use, handed over by the rack. */
export interface ModuleHost {
  readonly ctx: BaseAudioContext;
  /** True on an AudioContext (UI), false on an OfflineAudioContext (render). */
  readonly realtime: boolean;
  /** Publish domain events on the global bus (UI only). */
  readonly publishEvents: boolean;
  readonly events: EventBus;
  /** Acquire nodes / timers / streams / listeners through this so they are counted and released. */
  readonly ledger: ResourceLedger;
  /** The transport: steps, tempo, swing, lookahead horizon (engine-owned; the CLOCK module exposes it as jacks). */
  readonly clock: AudioClock;
  /** The output stage (engine-owned; the MASTER module exposes its input as a jack). */
  readonly masterBus: MasterBus;
  /** Input bus services for modules that own devices. */
  readonly input: InputService;
  /** Actual id of one of this instance's jacks, from its spec id. */
  portId(specId: string): string;
  /** Resume a suspended realtime context (user gesture); no-op offline. */
  resume(): Promise<void>;
  /** Play a note from one of this module's trigger-out jacks at `when`; true when any target sounded. */
  playNote(cmd: NoteCommand, when: number, fromPortId: string, extra?: NoteExtra): boolean;
  /** Publish a CV value from one of this module's cv-out jacks, effective from `when`. */
  setCv(portId: string, value: number, when: number): void;
  /** Snap a time toward the sequencer grid (0 = untouched, 1 = on the 16th). */
  quantizeTime(time: number, strength: number): number;
  /** Engine / OfflineAudioContext time reference (the clock's start time while playing). */
  now(): number;
}

export type ModuleState = Record<string, unknown>;

/**
 * Handler of a trigger-in jack: play `cmd` at `when` and return the command
 * as it sounded (e.g. with the frequency after PITCH CV, so scores carry the
 * sounding pitch), or null when the module does not respond to this command
 * (a drum module ignores a 'synth' note).
 */
export type TriggerHandler = (cmd: NoteCommand, when: number, extra: NoteExtra) => NoteCommand | null;

export interface ModuleInstance {
  readonly id: string;
  readonly descriptor: ModuleDescriptor;
  /** AudioNode behind each audio-out jack. */
  readonly audioOutputs?: Readonly<Record<string, AudioNode>>;
  /** AudioNode behind each audio-in jack. */
  readonly audioInputs?: Readonly<Record<string, AudioNode>>;
  /** Handler behind each trigger-in jack. */
  readonly triggerInputs?: Readonly<Record<string, TriggerHandler>>;
  /** Apply a resolved CV value to a cv-in jack (see CvBus for units). */
  setCvTarget?(portId: string, value: number, when: number): void;
  /** Release a note started with `extra.holdId` (modules without held notes ignore it). */
  releaseHeld?(holdId: string, when: number): void;
  /** Transport hooks (the clock's start time / stop). */
  onTransportStart?(startTime: number): void;
  onTransportStop?(): void;
  /** Serialisable state for presets, BOUNCE and tests. */
  getState?(): ModuleState;
  setState?(state: ModuleState): void;
  /** Release everything. Idempotent; the rack also releases the ledger afterwards. */
  dispose(): void;
}

export interface ModuleFactory {
  /** `state` is the preset entry's state (construction-time options such as a noise seed). */
  create(host: ModuleHost, id: string, state?: ModuleState): ModuleInstance;
}

/** What a module holds right now (from its ledger). */
export interface ModuleInspection extends ResourceCounts {
  id: string;
  type: string;
}

export interface RackInspection {
  modules: ModuleInspection[];
  /** Sum over modules. */
  total: ResourceCounts;
  /** Whether add / remove / clear are operational (false while the engine still routes by hand). */
  editable: boolean;
}

/** Derive a canvas port from a spec, with the id it has on `instanceId`. */
export function portFromSpec(spec: ModulePortSpec, type: string, instanceId: string): ModulePort {
  const port: ModulePort = {
    id: portIdFor(type, instanceId, spec.id),
    name: spec.name,
    type: spec.type,
    direction: spec.type.endsWith('-out') ? 'out' : 'in',
    color: spec.color,
  };
  if (spec.cvKind) port.cvKind = spec.cvKind;
  return port;
}
