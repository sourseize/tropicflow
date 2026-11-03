import { AudioContextManager, isRealtimeContext } from './AudioContextManager.ts';
import { MasterBus } from './MasterBus.ts';
import type { DelayEffect } from './DelayEffect.ts';
import type { OscillatorVoice } from './OscillatorVoice.ts';
import type { MarimbaModel } from './MarimbaModel.ts';
import type { PercussionEngine } from './PercussionEngine.ts';
import { AudioClock } from './AudioClock.ts';
import { EventBus } from '../events/EventBus.ts';
import type { StepTriggeredEvent } from '../events/DomainEvents.ts';
import type { GraphNode, PatchCable } from '../graph/GraphTypes.ts';
import { resolvePatch } from '../graph/PatchRouter.ts';
import type { ChamberConfig, ChamberEngine, ChamberNote } from '../physics/ChamberEngine.ts';
import type { NoteCommand } from '../physics/CollisionMapper.ts';
import type { CollisionEvent } from '../physics/ChamberTypes.ts';
import { type Take, TakeRecorder, type TakeStopReason } from '../record/TakeRecorder.ts';
import { InputBinding } from '../input/InputBinding.ts';
import { InputHub } from '../input/InputHub.ts';
import { type CvChange, CvBus, cvKinds } from '../cv/CvBus.ts';
import type { ModuleHost, ModuleInstance, NoteExtra, NoteSource, TriggerHandler } from '../modules/ModuleContract.ts';
import { portIdFor } from '../modules/ModuleContract.ts';
import { ModuleRack } from '../modules/ModuleRack.ts';
import { moduleRegistry } from '../modules/ModuleRegistry.ts';
import { DEFAULT_RACK, FULL_RACK, RACK_PRESETS, type RackPreset, clonePreset } from '../modules/RackPreset.ts';
import { ResourceLedger } from '../modules/ResourceLedger.ts';
// The built-in plugins register themselves on the application registry.
import '../../modules/index.ts';
import { CLOCK_TRIG_OUT } from '../../modules/clock/descriptor.ts';
import type { MarimbaModule } from '../../modules/marimba/module.ts';
import type { PercussionModule } from '../../modules/percussion/module.ts';
import type { SynthModule } from '../../modules/synth/module.ts';
import type { DelayModule } from '../../modules/delay/module.ts';
import type { ChamberModule } from '../../modules/chamber/module.ts';

export type TrackId = 'kick' | 'snare' | 'hihat' | 'marimba' | 'synth';
export type Pattern = Record<TrackId, boolean[]>;

export const PATTERN_STEPS = 16;

export const DEFAULT_PATTERN: Pattern = {
  kick:    [true,  false, false, false, true,  false, false, false, true,  false, false, false, true,  false, false, false],
  snare:   [false, false, false, false, true,  false, false, false, false, false, false, false, true,  false, false, false],
  hihat:   [true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true],
  marimba: [true,  false, false, true,  false, false, true,  false, false, true,  false, false, true,  false, true,  false],
  synth:   [false, false, true,  false, false, false, false, true,  false, false, true,  false, false, false, false, true],
};

export const MARIMBA_NOTES = [261.63, 293.66, 329.63, 392.0, 440.0, 523.25, 587.33, 659.25];
export const SYNTH_NOTES = [130.81, 164.81, 196.0, 220.0, 261.63];

export function clonePattern(p: Pattern): Pattern {
  return {
    kick: [...p.kick],
    snare: [...p.snare],
    hihat: [...p.hihat],
    marimba: [...p.marimba],
    synth: [...p.synth],
  };
}

/** A note the sequencer fired on a step. */
export interface FiredNote {
  track: TrackId;
  frequency?: number;
  velocity: number;
}

/**
 * Who asked for a note. All of them are trigger sources gated by cables from
 * their jack: the clock, the chamber, the MIDI BRIDGE ('midi': hardware MIDI
 * or the computer keys) and the SENSE module ('sensor': microphone / virtual
 * voice). Defined by the module contract; re-exported for existing imports.
 */
export type { NoteSource };

/** Every note the engine plays, from any source (used to build render scores). */
export interface PlayedNote extends FiredNote {
  time: number;
  source: NoteSource;
  step?: number;
  collision?: CollisionEvent;
}

export type StepListener = (stepIndex: number, audioTime: number, fired: FiredNote[]) => void;
export type NoteListener = (note: PlayedNote) => void;

/** A trigger-in jack patched from a trigger-out jack. */
interface TriggerTarget {
  instance: ModuleInstance;
  portId: string;
  handler: TriggerHandler;
}

export type PatchListener = (cables: PatchCable[]) => void;

/** A chamber note held back for an offline render, with the chamber it came from. */
export interface QueuedChamberNote {
  note: ChamberNote;
  module: ChamberModule;
}

export interface AudioEngineOptions {
  ctx: BaseAudioContext;
  /** Publish STEP_TRIGGERED / NOTE_ON events on the global EventBus (UI only). */
  publishEvents?: boolean;
  noiseSeed?: number;
  /** Cables of the default rack to start with (default: the default patch). */
  cables?: PatchCable[];
  /** Connect the master bus to ctx.destination (default true). */
  connectToDestination?: boolean;
  chamber?: Partial<ChamberConfig>;
  /**
   * The initial rack: 'default' (RESET PATCH's rack), 'empty' (nothing loaded,
   * no module code fetched), a preset name (see RACK_PRESETS) or an explicit
   * preset (renders). `cables` / `noiseSeed` / `chamber` apply on top.
   */
  rack?: 'default' | 'empty' | string | RackPreset;
}

/**
 * Wires the transport, the output stage and the patch routing together.
 *
 * `AudioEngine.getInstance()` returns the realtime singleton used by the UI.
 * `new AudioEngine({ ctx: offlineCtx })` builds an independent instance on an
 * OfflineAudioContext for deterministic rendering (see core/render).
 *
 * The modules are plugin instances in `rack` (core/modules). Routing is
 * generic: audio cables connect the AudioNodes the instances expose per
 * jack, trigger cables decide which trigger-in handlers a trigger-out jack
 * fires, CV cables feed the instances' `setCvTarget`. The engine itself owns
 * only what the fixed panels need with any rack: the transport clock, the
 * master bus, the take recorder and the input binding.
 */
export class AudioEngine {
  private static instance: AudioEngine | null = null;

  public readonly ctx: BaseAudioContext;
  /** The live modules (plugin instances), their resource ledgers and canvas nodes. */
  public readonly rack: ModuleRack;
  /** The output stage (engine-owned: the MASTER module is the jack into it). */
  public readonly masterBus: MasterBus;
  /** The transport (engine-owned: the CLOCK module is its trigger jack). */
  public readonly clock: AudioClock;
  /**
   * Resolves once the initial rack is loaded (module code is fetched on
   * demand, so building the default rack is asynchronous). Await it before
   * using the modules: `main.tsx` does, and so does the offline renderer.
   */
  public readonly ready: Promise<void>;
  /** Taps the master output to record what you hear (see core/record). */
  public readonly recorder: TakeRecorder;
  /** InputEvents (MIDI, computer keys, sensor, scripts) -> notes and CV, gated by cables (see core/input). */
  public readonly input: InputBinding;
  /** Input services for the modules that own devices: timestamp mapping, replay, byte injection (`window.tropicflowInput`). */
  public readonly inputHub: InputHub;
  /** CV routing: cv-out jacks -> cv-in jacks through cables (see core/cv). */
  public readonly cv: CvBus = new CvBus();
  private readonly eventBus: EventBus;
  private readonly publishEvents: boolean;

  private pattern: Pattern = clonePattern(DEFAULT_PATTERN);
  private nodes: GraphNode[] = [];
  private cables: PatchCable[] = [];
  /** Audio connections made for the current patch (disconnected individually on re-patch). */
  private audioLinks: Array<{ from: AudioNode; to: AudioNode }> = [];
  /** Per trigger-out jack, the trigger-in handlers patched to it. */
  private triggerLinks: Map<string, TriggerTarget[]> = new Map();
  /** Owner instance of every jack in the rack. */
  private portOwners: Map<string, ModuleInstance> = new Map();
  /** When non-null, only these tracks may sound (solo/mute for stem renders). */
  private trackMask: Set<TrackId> | null = null;

  private readonly stepListeners: Set<StepListener> = new Set();
  private readonly noteListeners: Set<NoteListener> = new Set();
  private readonly patchListeners: Set<PatchListener> = new Set();

  /** When set, chamber notes are queued here instead of played (offline time-ordered replay). */
  private chamberQueue: QueuedChamberNote[] | null = null;
  /** The clock's step hook into the chamber (bar-synced drops); the offline renderer pre-drives it itself. */
  public chamberStepHook: boolean = true;
  /** REC checkbox: record whenever the transport runs. */
  private recordArmed = false;
  private lastTake: Take | null = null;

  constructor(options: AudioEngineOptions) {
    this.ctx = options.ctx;
    this.publishEvents = options.publishEvents ?? false;
    this.eventBus = EventBus.getInstance();

    this.masterBus = new MasterBus(this.ctx, options.connectToDestination ?? true);
    this.clock = new AudioClock({ getTime: () => this.ctx.currentTime });
    this.recorder = new TakeRecorder(this.ctx, this.masterBus.outputNode, {
      onMaxLengthReached: (take) => this.storeTake(take, 'max-length'),
    });
    this.input = new InputBinding(this);
    this.inputHub = new InputHub(this);

    // Build the default rack; construction-time options travel as module state.
    this.rack = new ModuleRack(moduleRegistry, (id, type) => this.makeHost(id, type), true);
    const preset = AudioEngine.initialPreset(options.rack);
    for (const m of preset.modules) {
      if (m.type === 'percussion' && options.noiseSeed !== undefined) m.state = { ...m.state, noiseSeed: options.noiseSeed };
      if (m.type === 'chamber' && options.chamber) m.state = { ...m.state, config: options.chamber };
    }
    if (options.cables) preset.cables = options.cables.map((c) => ({ ...c }));
    this.rack.subscribe((change) => {
      if (change === 'modules' || change === 'reset') this.onRackChanged();
    });
    this.bindClock();
    this.ready = this.loadRack(preset);
  }

  private static initialPreset(rack: AudioEngineOptions['rack']): RackPreset {
    if (rack === 'empty') return { modules: [], cables: [] };
    if (rack === undefined || rack === 'default') return clonePreset(DEFAULT_RACK);
    if (typeof rack === 'string') {
      const named = RACK_PRESETS[rack];
      if (!named) throw new Error(`unknown rack preset "${rack}" (known: ${Object.keys(RACK_PRESETS).join(', ')})`);
      return clonePreset(named.preset);
    }
    return clonePreset(rack);
  }

  /** The services a module instance gets from the engine, plus its own resource ledger. */
  private makeHost(id: string, type: string): { host: ModuleHost; ledger: ResourceLedger } {
    const ledger = new ResourceLedger(this.ctx);
    const host: ModuleHost = {
      ctx: this.ctx,
      realtime: isRealtimeContext(this.ctx),
      publishEvents: this.publishEvents,
      events: this.eventBus,
      ledger,
      clock: this.clock,
      masterBus: this.masterBus,
      input: this.inputHub,
      portId: (specId) => portIdFor(type, id, specId),
      resume: () => this.resume(),
      playNote: (cmd, when, fromPortId, extra) => this.playNote(cmd, when, fromPortId, extra),
      setCv: (portId, value, when) => this.setCvSource(portId, value, when),
      quantizeTime: (time, strength) => this.clock.quantizeTime(time, strength),
      now: () => this.ctx.currentTime,
    };
    return { host, ledger };
  }

  /** Realtime singleton bound to the browser AudioContext (`options` count on the first call only). */
  public static getInstance(options: Pick<AudioEngineOptions, 'rack'> = {}): AudioEngine {
    if (!AudioEngine.instance) {
      AudioEngine.instance = new AudioEngine({
        ctx: AudioContextManager.getInstance().getContext(),
        publishEvents: true,
        rack: options.rack,
      });
    }
    return AudioEngine.instance;
  }

  // -------------------------------------------------------------------
  // Rack editing (the canvas, RESET PATCH, CLEAR ALL, the module browser)
  // -------------------------------------------------------------------

  /**
   * Replace every module and cable with a preset (RESET PATCH = the default
   * rack). Module code not yet in memory is fetched first; the rack is
   * cleared immediately and the cables are applied once every module exists.
   */
  public async loadRack(preset: RackPreset): Promise<void> {
    this.suspendRackEvents = true;
    try {
      await this.rack.loadAsync(preset);
    } finally {
      this.suspendRackEvents = false;
    }
    this.installChamberSinks();
    this.applyPatch(preset.cables);
  }

  public resetRack(): Promise<void> {
    return this.loadRack(clonePreset(DEFAULT_RACK));
  }

  /** Load a named preset (see RACK_PRESETS: 'default', 'full'). */
  public loadPreset(name: string): Promise<void> {
    return this.loadRack(AudioEngine.initialPreset(name));
  }

  /** The full studio's cables (applying them to a partial rack keeps the ones whose jacks exist). */
  public defaultCables(): PatchCable[] {
    return FULL_RACK.cables.map((c) => ({ ...c }));
  }

  /** Remove every module (and so every cable). */
  public clearRack(): void {
    this.rack.clear();
  }

  /** Add a module of `type` (loads its code when needed); cables are untouched. */
  public async addModule(type: string, position?: { x: number; y: number }): Promise<ModuleInstance> {
    return this.rack.add(type, { position });
  }

  /** Remove one module; cables attached to it are cut. */
  public removeModule(id: string): boolean {
    return this.rack.remove(id);
  }

  private suspendRackEvents = false;

  /** Modules changed: re-resolve the patch without the cables that lost a jack. */
  private onRackChanged(): void {
    if (this.suspendRackEvents) return;
    this.installChamberSinks();
    this.applyPatch(this.cables);
  }

  private installChamberSinks(): void {
    for (const m of this.rack.list()) {
      if (m.descriptor.type === 'chamber') (m as ChamberModule).sink = (note, module) => this.playChamberNote(note, false, module);
    }
  }

  // -------------------------------------------------------------------
  // Patch routing
  // -------------------------------------------------------------------

  /**
   * Re-wire the audio graph, trigger gating and CV routing from a set of
   * cables. Cables whose jacks are no longer in the rack are dropped. Audio
   * cables connect the AudioNodes behind the jacks; trigger cables decide
   * which trigger-in handlers a trigger-out jack fires; CV cables feed the
   * modules' CV targets (see core/cv/CvBus).
   */
  public applyPatch(cables: PatchCable[]): void {
    this.nodes = this.rack.nodes();
    this.portOwners = new Map();
    for (const instance of this.rack.list()) {
      const node = this.nodes.find((n) => n.id === instance.id);
      if (!node) continue;
      for (const p of node.inputs) this.portOwners.set(p.id, instance);
      for (const p of node.outputs) this.portOwners.set(p.id, instance);
    }
    const resolved = resolvePatch(cables, this.nodes);
    const invalid = new Set(resolved.invalid.map((c) => c.id));
    this.cables = cables.filter((c) => !invalid.has(c.id)).map((c) => ({ ...c }));

    for (const link of this.audioLinks) {
      try {
        link.from.disconnect(link.to);
      } catch {
        /* the node was disposed with its module */
      }
    }
    this.audioLinks = [];
    for (const link of resolved.audio) {
      const from = this.portOwners.get(link.fromPortId)?.audioOutputs?.[link.fromPortId];
      const to = this.portOwners.get(link.toPortId)?.audioInputs?.[link.toPortId];
      if (!from || !to) continue;
      from.connect(to);
      this.audioLinks.push({ from, to });
    }

    this.triggerLinks = new Map();
    for (const link of resolved.trigger) {
      const instance = this.portOwners.get(link.toPortId);
      const handler = instance?.triggerInputs?.[link.toPortId];
      if (!instance || !handler) continue;
      if (!this.triggerLinks.has(link.fromPortId)) this.triggerLinks.set(link.fromPortId, []);
      this.triggerLinks.get(link.fromPortId)!.push({ instance, portId: link.toPortId, handler });
    }

    this.applyCvChanges(this.cv.setLinks(resolved.cv, cvKinds(this.nodes)), this.ctx.currentTime);
    for (const l of Array.from(this.patchListeners)) l(this.getPatch());
    if (this.publishEvents) this.eventBus.publish({ type: 'PATCH_CHANGED', timestamp: performance.now(), cableCount: this.cables.length });
  }

  /** Observe cable changes (the canvas mirrors the engine's patch). */
  public subscribePatch(listener: PatchListener): () => void {
    this.patchListeners.add(listener);
    return () => {
      this.patchListeners.delete(listener);
    };
  }

  // -------------------------------------------------------------------
  // CV
  // -------------------------------------------------------------------

  /** Publish a CV source value (mod wheel, bend, swing, sensor) effective from `when`. */
  public setCvSource(portId: string, value: number, when: number): void {
    this.applyCvChanges(this.cv.setSource(portId, value), when);
  }

  private applyCvChanges(changes: CvChange[], when: number): void {
    for (const c of changes) this.portOwners.get(c.targetPortId)?.setCvTarget?.(c.targetPortId, c.value, when);
  }

  public getPatch(): PatchCable[] {
    return this.cables.map((c) => ({ ...c }));
  }

  public getNodes(): GraphNode[] {
    return this.nodes;
  }

  /** Score label of a trigger-out jack (from its module's descriptor). */
  private noteSourceOf(fromPortId: string): NoteSource {
    const owner = this.portOwners.get(fromPortId);
    const spec = owner?.descriptor.ports.find((p) => portIdFor(owner.descriptor.type, owner.id, p.id) === fromPortId);
    return spec?.noteSource ?? owner?.descriptor.type ?? 'unknown';
  }

  /** Whether any module of `type` has a trigger-in patched from a jack labelled `source`. */
  public isTriggerTarget(type: string, source: NoteSource = 'sequencer'): boolean {
    for (const [fromPortId, targets] of this.triggerLinks) {
      if (this.noteSourceOf(fromPortId) !== source) continue;
      if (targets.some((t) => t.instance.descriptor.type === type)) return true;
    }
    return false;
  }

  /** Observe every note played, from any source. */
  public subscribeNotes(listener: NoteListener): () => void {
    this.noteListeners.add(listener);
    return () => {
      this.noteListeners.delete(listener);
    };
  }

  private emitNote(note: PlayedNote): void {
    this.noteListeners.forEach((l) => l(note));
  }

  /**
   * Fire a note from the trigger-out jack `fromPortId` at `when`: every
   * trigger-in patched to it is offered the command; those that respond
   * sound it and a PlayedNote is emitted per sounding module (with the
   * frequency as it sounded, e.g. after PITCH CV). Returns true when any
   * module sounded. With `extra.holdId` a note is held until
   * `releaseHeld(holdId)` instead of using `cmd.duration`.
   */
  public playNote(cmd: NoteCommand, when: number, fromPortId: string, extra: NoteExtra = {}): boolean {
    if (this.trackMask !== null && !this.trackMask.has(cmd.track)) return false;
    const targets = this.triggerLinks.get(fromPortId);
    if (!targets || targets.length === 0) return false;
    const source = this.noteSourceOf(fromPortId);
    let sounded = false;
    for (const target of targets) {
      const played = target.handler(cmd, when, extra);
      if (!played) continue;
      sounded = true;
      const { step, collision } = extra;
      this.emitNote({ time: when, track: played.track, frequency: played.frequency, velocity: played.velocity, source, step, collision });
    }
    return sounded;
  }

  /** Release a note that was started with `playNote(..., { holdId })` (every module that holds notes). */
  public releaseHeld(holdId: string, when: number): void {
    for (const m of this.rack.list()) m.releaseHeld?.(holdId, when);
  }

  /**
   * Offline rendering: queue chamber notes so the renderer can apply them in
   * time order with input events (CV state at the note's time) while the
   * physics still runs in one pass (its collision times are sub-step exact
   * only then). Returns the queue; call `playChamberNote` for each entry.
   */
  public deferChamberNotes(): QueuedChamberNote[] {
    this.chamberQueue = [];
    return this.chamberQueue;
  }

  public stopDeferringChamberNotes(): void {
    this.chamberQueue = null;
  }

  public playChamberNote(note: ChamberNote, force: boolean = false, module: ChamberModule | null = null): void {
    const source = module ?? this.chamberModule();
    if (!source) return;
    if (this.chamberQueue && !force) {
      this.chamberQueue.push({ note, module: source });
      return;
    }
    const fromPortId = source.trigOut;
    const sounded = this.playNote(note.command, note.time, fromPortId, { collision: note.collision });
    if (!sounded || !this.publishEvents) return;
    this.eventBus.publish({
      type: 'CHAMBER_COLLISION',
      timestamp: performance.now(),
      audioTime: note.time,
      contextTime: this.ctx.currentTime,
      ballId: note.collision.ballId,
      surfaceId: note.collision.surfaceId,
      surfaceKind: note.collision.surfaceKind,
      track: note.command.track,
      impactSpeed: note.collision.impactSpeed,
    });
  }

  // -------------------------------------------------------------------
  // Module accessors (the default rack's instances; throw when absent)
  // -------------------------------------------------------------------

  private moduleOfType<T extends ModuleInstance>(type: string): T {
    const m = this.rack.findByType<T>(type);
    if (!m) throw new Error(`no ${type} module in the rack`);
    return m;
  }

  public get synth(): OscillatorVoice {
    return this.moduleOfType<SynthModule>('synth').voice;
  }

  public get marimba(): MarimbaModel {
    return this.moduleOfType<MarimbaModule>('marimba').model;
  }

  public get drums(): PercussionEngine {
    return this.moduleOfType<PercussionModule>('percussion').drums;
  }

  public get delay(): DelayEffect {
    return this.moduleOfType<DelayModule>('delay').effect;
  }

  /** The (first) gravity chamber's physics engine. */
  public get chamber(): ChamberEngine {
    return this.moduleOfType<ChamberModule>('chamber').engine;
  }

  private chamberModule(): ChamberModule | null {
    return this.rack.findByType<ChamberModule>('chamber');
  }

  /** Every gravity chamber in the rack (the offline renderer drives them itself). */
  public chamberEngines(): ChamberEngine[] {
    return this.rack.list().filter((m) => m.descriptor.type === 'chamber').map((m) => (m as ChamberModule).engine);
  }

  private chambers(): ChamberEngine[] {
    return this.chamberEngines();
  }

  // -------------------------------------------------------------------
  // Sequencer
  // -------------------------------------------------------------------

  /** Observe every sequenced step (after it has been scheduled) with the tracks it fired. */
  public subscribeSteps(listener: StepListener): () => void {
    this.stepListeners.add(listener);
    return () => {
      this.stepListeners.delete(listener);
    };
  }

  private bindClock(): void {
    this.clock.subscribeHorizon((horizon) => {
      for (const c of this.chambers()) if (c.isRunning()) c.runTo(horizon);
    });
    this.clock.subscribe((stepIndex, audioTime) => {
      if (this.chamberStepHook) for (const c of this.chambers()) c.onStep(stepIndex, audioTime);
      const fired = this.triggerStep(stepIndex, audioTime);
      this.stepListeners.forEach((l) => l(stepIndex, audioTime, fired));
      if (!this.publishEvents) return;
      const activeTracks = fired.map((n) => n.track);

      const event: StepTriggeredEvent = {
        type: 'STEP_TRIGGERED',
        timestamp: performance.now(),
        stepIndex,
        activeTracks,
        audioTime,
        contextTime: this.ctx.currentTime,
      };
      this.eventBus.publish(event);
    });
  }

  /**
   * Fire every track active on `stepIndex` at exactly `audioTime`.
   * Exposed so offline renderers and tests can reuse the exact mapping.
   */
  public triggerStep(stepIndex: number, audioTime: number): FiredNote[] {
    const fired: FiredNote[] = [];
    const play = (cmd: NoteCommand) => {
      if (this.playNote(cmd, audioTime, CLOCK_TRIG_OUT, { step: stepIndex })) {
        fired.push({ track: cmd.track, frequency: cmd.frequency, velocity: cmd.velocity });
      }
    };

    if (this.pattern.kick[stepIndex]) play({ track: 'kick', velocity: 0.95 });
    if (this.pattern.snare[stepIndex]) play({ track: 'snare', velocity: 0.8 });
    if (this.pattern.hihat[stepIndex]) play({ track: 'hihat', velocity: 0.65, open: stepIndex % 4 === 2 });
    if (this.pattern.marimba[stepIndex]) {
      play({ track: 'marimba', frequency: MARIMBA_NOTES[(stepIndex * 2) % MARIMBA_NOTES.length], velocity: 0.75 });
    }
    if (this.pattern.synth[stepIndex]) {
      play({ track: 'synth', frequency: SYNTH_NOTES[stepIndex % SYNTH_NOTES.length], velocity: 0.7, duration: 0.18 });
    }
    return fired;
  }

  /** Restrict which tracks may sound (null = all). */
  public setTrackMask(tracks: TrackId[] | null): void {
    this.trackMask = tracks ? new Set(tracks) : null;
  }

  public async resume(): Promise<void> {
    if (isRealtimeContext(this.ctx) && this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  public async startAudio(): Promise<void> {
    await this.resume();
    // Connect the tap before the first step is scheduled so nothing is missed.
    if (this.recordArmed) await this.startTake();
    this.clock.start();
    this.rack.transportStart(this.clock.getStartTime());
    // The performance log is anchored to the first step, like a bounce's t = 0.
    this.input.log.start(this.clock.getStartTime());
    if (this.publishEvents) {
      this.eventBus.publish({ type: 'AUDIO_STARTED', timestamp: performance.now() });
    }
  }

  public stopAudio(): void {
    this.clock.stop();
    this.rack.transportStop();
    this.input.log.stop();
    if (this.recorder.isRecording()) void this.stopTake('stopped');
    if (this.publishEvents) {
      this.eventBus.publish({ type: 'AUDIO_STOPPED', timestamp: performance.now() });
    }
  }

  // -------------------------------------------------------------------
  // Take recording: runs while the transport plays AND the REC box is ticked
  // -------------------------------------------------------------------

  public isRecordArmed(): boolean {
    return this.recordArmed;
  }

  /**
   * Tick/untick REC. Ticking while playing starts recording immediately;
   * unticking while recording finalises the take.
   */
  public async setRecordArmed(armed: boolean): Promise<void> {
    if (this.recordArmed === armed) return;
    this.recordArmed = armed;
    if (armed && this.clock.getIsPlaying() && !this.recorder.isRecording()) {
      await this.startTake();
    } else if (!armed && this.recorder.isRecording()) {
      await this.stopTake('stopped');
    }
  }

  /** The most recent finished take (a new recording replaces it). */
  public getLastTake(): Take | null {
    return this.lastTake;
  }

  public clearLastTake(): void {
    this.lastTake = null;
  }

  private async startTake(): Promise<void> {
    try {
      await this.recorder.start(this.clock.getBpm());
      if (this.publishEvents) {
        this.eventBus.publish({ type: 'TAKE_STARTED', timestamp: performance.now(), durationSeconds: 0 });
      }
    } catch (err) {
      console.error('[AudioEngine] could not start recording', err);
    }
  }

  private async stopTake(reason: TakeStopReason): Promise<void> {
    const take = await this.recorder.stop();
    this.storeTake(take, reason);
  }

  private storeTake(take: Take | null, reason: TakeStopReason): void {
    if (take) this.lastTake = take;
    if (this.publishEvents) {
      this.eventBus.publish({
        type: 'TAKE_STOPPED',
        timestamp: performance.now(),
        durationSeconds: take?.durationSeconds ?? 0,
        reason: take ? reason : 'empty',
      });
    }
  }

  public togglePatternStep(track: TrackId, stepIndex: number): boolean {
    if (this.pattern[track] && stepIndex >= 0 && stepIndex < PATTERN_STEPS) {
      this.pattern[track][stepIndex] = !this.pattern[track][stepIndex];
      return this.pattern[track][stepIndex];
    }
    return false;
  }

  public getPattern(): Pattern {
    return this.pattern;
  }

  public setPattern(pattern: Pattern): void {
    this.pattern = clonePattern(pattern);
  }
}
