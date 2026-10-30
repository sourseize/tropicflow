import { AudioContextManager, isRealtimeContext } from './AudioContextManager.ts';
import { MasterBus } from './MasterBus.ts';
import { DelayEffect } from './DelayEffect.ts';
import { OscillatorVoice } from './OscillatorVoice.ts';
import { MarimbaModel } from './MarimbaModel.ts';
import { DEFAULT_NOISE_SEED, PercussionEngine } from './PercussionEngine.ts';
import { AudioClock } from './AudioClock.ts';
import { EventBus } from '../events/EventBus.ts';
import type { NoteOnEvent, StepTriggeredEvent } from '../events/DomainEvents.ts';
import type { GraphNode, PatchCable } from '../graph/GraphTypes.ts';
import { INITIAL_CABLES, INITIAL_NODES } from '../graph/NodeGraph.ts';
import { resolvePatch } from '../graph/PatchRouter.ts';
import { type ChamberConfig, ChamberEngine, type ChamberNote } from '../physics/ChamberEngine.ts';
import type { NoteCommand } from '../physics/CollisionMapper.ts';
import type { CollisionEvent } from '../physics/ChamberTypes.ts';

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

export type NoteSource = 'sequencer' | 'chamber' | 'keyboard';

/** Every note the engine plays, from any source (used to build render scores). */
export interface PlayedNote extends FiredNote {
  time: number;
  source: NoteSource;
  step?: number;
  collision?: CollisionEvent;
}

export type StepListener = (stepIndex: number, audioTime: number, fired: FiredNote[]) => void;
export type NoteListener = (note: PlayedNote) => void;

/** Trigger sources: which output jack drives which modules. */
const TRIGGER_SOURCES: Record<string, NoteSource> = {
  'clk-trig-1': 'sequencer',
  'chm-trig-out': 'chamber',
};

export interface AudioEngineOptions {
  ctx: BaseAudioContext;
  /** Publish STEP_TRIGGERED / NOTE_ON events on the global EventBus (UI only). */
  publishEvents?: boolean;
  noiseSeed?: number;
  nodes?: GraphNode[];
  cables?: PatchCable[];
  /** Connect the master bus to ctx.destination (default true). */
  connectToDestination?: boolean;
  chamber?: Partial<ChamberConfig>;
}

/**
 * Wires voices, effects, clock and patch routing together.
 *
 * `AudioEngine.getInstance()` returns the realtime singleton used by the UI.
 * `new AudioEngine({ ctx: offlineCtx })` builds an independent instance on an
 * OfflineAudioContext for deterministic rendering (see core/render).
 */
export class AudioEngine {
  private static instance: AudioEngine | null = null;

  public readonly ctx: BaseAudioContext;
  public readonly masterBus: MasterBus;
  public readonly delay: DelayEffect;
  public readonly synth: OscillatorVoice;
  public readonly marimba: MarimbaModel;
  public readonly drums: PercussionEngine;
  public readonly clock: AudioClock;
  public readonly chamber: ChamberEngine;
  private readonly eventBus: EventBus;
  private readonly publishEvents: boolean;

  private pattern: Pattern = clonePattern(DEFAULT_PATTERN);
  private nodes: GraphNode[];
  private cables: PatchCable[] = [];
  /** Per trigger source, the modules whose trigger input is patched to it. */
  private triggerTargets: Map<NoteSource, Set<string>> = new Map();
  /** When non-null, only these tracks may sound (solo/mute for stem renders). */
  private trackMask: Set<TrackId> | null = null;

  private readonly stepListeners: Set<StepListener> = new Set();
  private readonly noteListeners: Set<NoteListener> = new Set();

  private readonly outputPorts: Map<string, AudioNode>;
  private readonly inputPorts: Map<string, AudioNode>;
  private readonly triggerInputPorts: Map<string, string>;

  constructor(options: AudioEngineOptions) {
    this.ctx = options.ctx;
    this.publishEvents = options.publishEvents ?? false;
    this.eventBus = EventBus.getInstance();
    this.nodes = options.nodes ?? INITIAL_NODES;

    this.masterBus = new MasterBus(this.ctx, options.connectToDestination ?? true);
    this.delay = new DelayEffect(this.ctx);
    this.synth = new OscillatorVoice(this.ctx);
    this.marimba = new MarimbaModel(this.ctx);
    this.drums = new PercussionEngine(this.ctx, options.noiseSeed ?? DEFAULT_NOISE_SEED);
    this.clock = new AudioClock({ getTime: () => this.ctx.currentTime });
    this.chamber = new ChamberEngine(options.chamber ?? {}, {
      sink: (note) => this.playChamberNote(note),
      quantizer: (time, strength) => this.clock.quantizeTime(time, strength),
      onChanged: () => {
        if (this.publishEvents) this.eventBus.publish({ type: 'CHAMBER_CHANGED', timestamp: performance.now() });
      },
    });

    this.outputPorts = new Map<string, AudioNode>([
      ['mrm-audio-out', this.marimba.outputNode],
      ['syn-audio-out', this.synth.outputNode],
      ['perc-audio-out', this.drums.outputNode],
      ['del-wet-out', this.delay.outputNode],
    ]);
    this.inputPorts = new Map<string, AudioNode>([
      ['del-audio-in', this.delay.inputNode],
      ['mst-in-l', this.masterBus.inputNode],
    ]);
    this.triggerInputPorts = new Map<string, string>([
      ['mrm-trig-in', 'marimba'],
      ['perc-trig-in', 'percussion'],
      ['syn-gate-in', 'synth'],
    ]);

    this.applyPatch(options.cables ?? INITIAL_CABLES);
    this.bindClock();
  }

  /** Realtime singleton bound to the browser AudioContext. */
  public static getInstance(): AudioEngine {
    if (!AudioEngine.instance) {
      AudioEngine.instance = new AudioEngine({
        ctx: AudioContextManager.getInstance().getContext(),
        publishEvents: true,
      });
    }
    return AudioEngine.instance;
  }

  // -------------------------------------------------------------------
  // Patch routing
  // -------------------------------------------------------------------

  /**
   * Re-wire the audio graph and trigger gating from a set of cables.
   * Audio cables connect module outputs to module inputs; trigger cables
   * decide which modules the clock is allowed to fire. CV cables are
   * accepted but have no effect yet.
   */
  public applyPatch(cables: PatchCable[]): void {
    this.cables = cables.map((c) => ({ ...c }));
    const resolved = resolvePatch(cables, this.nodes);

    for (const node of this.outputPorts.values()) {
      node.disconnect();
    }
    for (const link of resolved.audio) {
      const from = this.outputPorts.get(link.fromPortId);
      const to = this.inputPorts.get(link.toPortId);
      if (from && to) from.connect(to);
    }

    this.triggerTargets = new Map<NoteSource, Set<string>>();
    for (const link of resolved.trigger) {
      const source = TRIGGER_SOURCES[link.fromPortId];
      const target = this.triggerInputPorts.get(link.toPortId);
      if (!source || !target) continue;
      if (!this.triggerTargets.has(source)) this.triggerTargets.set(source, new Set());
      this.triggerTargets.get(source)!.add(target);
    }
  }

  public getPatch(): PatchCable[] {
    return this.cables.map((c) => ({ ...c }));
  }

  public getNodes(): GraphNode[] {
    return this.nodes;
  }

  public isTriggerTarget(module: 'marimba' | 'percussion' | 'synth', source: NoteSource = 'sequencer'): boolean {
    return this.triggerTargets.get(source)?.has(module) ?? false;
  }

  private moduleForTrack(track: TrackId): 'marimba' | 'percussion' | 'synth' {
    if (track === 'marimba') return 'marimba';
    if (track === 'synth') return 'synth';
    return 'percussion';
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
   * Play a note at `when` if the source is patched to the instrument's
   * module and the track is not muted. Returns true when it sounded.
   */
  public playNote(cmd: NoteCommand, when: number, source: NoteSource, extra: { step?: number; collision?: CollisionEvent } = {}): boolean {
    const module = this.moduleForTrack(cmd.track);
    if (source !== 'keyboard' && !this.isTriggerTarget(module, source)) return false;
    if (this.trackMask !== null && !this.trackMask.has(cmd.track)) return false;

    switch (cmd.track) {
      case 'kick':
        this.drums.triggerKick(cmd.velocity, when);
        break;
      case 'snare':
        this.drums.triggerSnare(cmd.velocity, when);
        break;
      case 'hihat':
        this.drums.triggerHiHat(cmd.velocity, cmd.open ?? false, when);
        break;
      case 'marimba':
        this.marimba.strike(cmd.frequency ?? MARIMBA_NOTES[0], cmd.velocity, when);
        break;
      case 'synth':
        this.synth.triggerNote(cmd.frequency ?? SYNTH_NOTES[0], cmd.velocity, cmd.duration ?? 0.18, when);
        break;
    }
    this.emitNote({ time: when, track: cmd.track, frequency: cmd.frequency, velocity: cmd.velocity, source, ...extra });
    return true;
  }

  private playChamberNote(note: ChamberNote): void {
    const sounded = this.playNote(note.command, note.time, 'chamber', { collision: note.collision });
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
      if (this.chamber.isRunning()) this.chamber.runTo(horizon);
    });
    this.clock.subscribe((stepIndex, audioTime) => {
      this.chamber.onStep(stepIndex, audioTime);
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
      if (this.playNote(cmd, audioTime, 'sequencer', { step: stepIndex })) {
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
    this.clock.start();
    this.chamber.start(this.clock.getStartTime());
    if (this.publishEvents) {
      this.eventBus.publish({ type: 'AUDIO_STARTED', timestamp: performance.now() });
    }
  }

  public stopAudio(): void {
    this.clock.stop();
    this.chamber.stop();
    if (this.publishEvents) {
      this.eventBus.publish({ type: 'AUDIO_STOPPED', timestamp: performance.now() });
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

  public playDirectNote(channel: 'synth' | 'marimba', frequency: number): void {
    void this.resume();
    if (channel === 'synth') {
      this.playNote({ track: 'synth', frequency, velocity: 0.85, duration: 0.3 }, this.ctx.currentTime, 'keyboard');
    } else {
      this.playNote({ track: 'marimba', frequency, velocity: 0.9 }, this.ctx.currentTime, 'keyboard');
    }

    if (!this.publishEvents) return;
    const event: NoteOnEvent = {
      type: 'NOTE_ON',
      timestamp: performance.now(),
      channel,
      frequency,
      velocity: 0.85,
    };
    this.eventBus.publish(event);
  }
}
