import { PhysicsChamber } from './PhysicsChamber.ts';
import { type ChamberMapping, DEFAULT_MAPPING, type NoteCommand, mapCollision } from './CollisionMapper.ts';
import { type BallState, type ChamberPhysicsConfig, type ChamberSnapshot, type CollisionEvent, DEFAULT_PHYSICS_CONFIG } from './ChamberTypes.ts';

export interface ChamberConfig {
  enabled: boolean;
  physics: Partial<ChamberPhysicsConfig>;
  mapping: ChamberMapping;
  /** 0 = free physics timing, 1 = snap every hit to the nearest 16th. */
  quantize: number;
  /** Drop a ball on the first step of every N bars (0 = off). */
  autoDropBars: number;
  /** Horizontal drop position (chamber units); null = seeded random. */
  dropX: number | null;
  /** Manual DROP: immediately, or on the next bar start while playing. */
  dropSync: 'now' | 'bar';
}

export const DEFAULT_CHAMBER_CONFIG: ChamberConfig = {
  enabled: true,
  physics: {},
  mapping: DEFAULT_MAPPING,
  quantize: 0,
  autoDropBars: 0,
  dropX: null,
  dropSync: 'now',
};

export interface ChamberNote {
  /** Time the note is scheduled at (collision time, possibly quantized). */
  time: number;
  command: NoteCommand;
  collision: CollisionEvent;
}

export interface ChamberEngineDeps {
  /** Receives every note the chamber wants to play. */
  sink: (note: ChamberNote) => void;
  /** Snaps a time toward the sequencer grid with the given strength. */
  quantizer?: (time: number, strength: number) => number;
  /** Called after drops / clears / geometry edits (UI refresh). */
  onChanged?: () => void;
}

const SNAPSHOT_INTERVAL = 1 / 120;
const SNAPSHOT_HISTORY = 240;
const FLASH_SECONDS = 0.25;

/**
 * Drives a PhysicsChamber in audio time, turning collisions into scheduled
 * notes. The realtime clock steps it to its lookahead horizon on every tick;
 * the offline renderer steps it across the whole render. Snapshots are kept
 * so the UI can draw the chamber at the *audible* time rather than the
 * (future) simulated time.
 */
export class ChamberEngine {
  public physics: PhysicsChamber;
  private config: ChamberConfig;
  private readonly deps: ChamberEngineDeps;
  private running: boolean = false;
  private pendingDrops: Array<{ time: number; x: number | null }> = [];
  private pendingBarDrops: Array<number | null> = [];
  private lastTime: number = 0;
  private snapshots: ChamberSnapshot[] = [];
  private recentHits: Array<{ time: number; event: CollisionEvent; track: string }> = [];
  private barCounter: number = 0;

  constructor(config: Partial<ChamberConfig>, deps: ChamberEngineDeps) {
    this.config = ChamberEngine.normaliseConfig(config);
    this.deps = deps;
    this.physics = new PhysicsChamber(this.config.physics);
  }

  public static normaliseConfig(config: Partial<ChamberConfig>): ChamberConfig {
    return {
      ...DEFAULT_CHAMBER_CONFIG,
      ...config,
      physics: { ...(config.physics ?? {}) },
      mapping: { ...DEFAULT_MAPPING, ...(config.mapping ?? {}) },
    };
  }

  // -------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------

  public getConfig(): Readonly<ChamberConfig> {
    return this.config;
  }

  public updateConfig(patch: Partial<ChamberConfig>): void {
    this.config = ChamberEngine.normaliseConfig({ ...this.config, ...patch, physics: { ...this.config.physics, ...(patch.physics ?? {}) } });
    if (patch.physics) this.physics.updateConfig(patch.physics);
    this.deps.onChanged?.();
  }

  public updatePhysics(patch: Partial<ChamberPhysicsConfig>): void {
    this.updateConfig({ physics: patch });
  }

  public updateMapping(patch: Partial<ChamberMapping>): void {
    this.updateConfig({ mapping: { ...this.config.mapping, ...patch } });
  }

  /** Replace the whole chamber (geometry, balls, mapping, settings) e.g. from an imported file. */
  public loadConfig(config: Partial<ChamberConfig>): void {
    this.config = ChamberEngine.normaliseConfig(config);
    this.physics = new PhysicsChamber(this.config.physics);
    this.pendingDrops = [];
    this.snapshots = [];
    this.recentHits = [];
    if (this.running) this.physics.setTime(this.lastTime);
    this.deps.onChanged?.();
  }

  /** Full config including live ball positions, for bounce/serialisation. */
  public exportConfig(): ChamberConfig {
    return {
      ...this.config,
      mapping: { ...this.config.mapping },
      physics: this.physics.exportConfig(),
    };
  }

  public isEnabled(): boolean {
    return this.config.enabled;
  }

  // -------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------

  /** Align the simulation clock with the audio timeline and start stepping. */
  public start(time: number): void {
    this.lastTime = time;
    this.physics.setTime(time);
    for (const d of this.pendingDrops) if (d.time < time) d.time = time;
    this.running = true;
    this.barCounter = 0;
    this.snapshots = [this.physics.snapshot()];
  }

  public stop(): void {
    this.running = false;
    this.pendingBarDrops = [];
  }

  public isRunning(): boolean {
    return this.running;
  }

  // -------------------------------------------------------------------
  // Drops
  // -------------------------------------------------------------------

  /**
   * Drop a ball. With a time in the future (relative to the simulation) the
   * drop is queued and applied at exactly that time; otherwise immediately.
   * When `dropSync` is 'bar' and the transport runs, a drop without an
   * explicit time waits for the next bar start instead.
   */
  public requestDrop(atTime?: number, x?: number | null): void {
    const dropX = x === undefined ? this.config.dropX : x;
    if (atTime === undefined && this.config.dropSync === 'bar' && this.running) {
      this.pendingBarDrops.push(dropX);
      this.deps.onChanged?.();
      return;
    }
    const now = this.physics.getTime();
    if (atTime === undefined || atTime <= now) {
      this.physics.dropBall(dropX ?? undefined);
      this.deps.onChanged?.();
      return;
    }
    this.pendingDrops.push({ time: atTime, x: dropX });
    this.pendingDrops.sort((a, b) => a.time - b.time);
  }

  public clearBalls(): void {
    this.physics.clearBalls();
    this.pendingDrops = [];
    this.deps.onChanged?.();
  }

  /** Sequencer hook: auto-drop on the first step of every `autoDropBars` bars; release bar-synced manual drops. */
  public onStep(stepIndex: number, time: number): void {
    if (!this.config.enabled || stepIndex !== 0) return;
    const every = this.config.autoDropBars;
    if (every > 0 && this.barCounter % every === 0) this.requestDrop(time);
    for (const x of this.pendingBarDrops) this.requestDrop(time, x);
    this.pendingBarDrops = [];
    this.barCounter++;
  }

  /** Manual drops waiting for the next bar (dropSync = 'bar'). */
  public pendingBarDropCount(): number {
    return this.pendingBarDrops.length;
  }

  // -------------------------------------------------------------------
  // Stepping
  // -------------------------------------------------------------------

  /** Simulate up to `horizon`, scheduling notes for every collision found. */
  public runTo(horizon: number): ChamberNote[] {
    if (!this.config.enabled) return [];
    const notes: ChamberNote[] = [];
    let t = this.physics.getTime();
    while (horizon - t > 1e-9) {
      const nextDrop = this.pendingDrops[0]?.time ?? Infinity;
      const chunkEnd = Math.min(horizon, t + SNAPSHOT_INTERVAL, nextDrop);
      if (chunkEnd > t) {
        for (const ev of this.physics.stepTo(chunkEnd)) this.handleCollision(ev, notes);
        this.pushSnapshot();
      }
      t = this.physics.getTime();
      this.lastTime = t;
      while (this.pendingDrops.length && this.pendingDrops[0].time <= t + 1e-9) {
        const d = this.pendingDrops.shift()!;
        this.physics.dropBall(d.x ?? undefined);
        this.deps.onChanged?.();
      }
    }
    return notes;
  }

  private handleCollision(ev: CollisionEvent, notes: ChamberNote[]): void {
    const command = mapCollision(ev, this.config.mapping);
    if (!command) return;
    let time = ev.time;
    if (this.config.quantize > 0 && this.deps.quantizer) {
      time = this.deps.quantizer(ev.time, this.config.quantize);
    }
    const note: ChamberNote = { time, command, collision: ev };
    notes.push(note);
    this.recentHits.push({ time, event: ev, track: command.track });
    this.deps.sink(note);
  }

  private pushSnapshot(): void {
    this.snapshots.push(this.physics.snapshot());
    if (this.snapshots.length > SNAPSHOT_HISTORY) this.snapshots.splice(0, this.snapshots.length - SNAPSHOT_HISTORY);
    const cutoff = this.physics.getTime() - 2;
    if (this.recentHits.length && this.recentHits[0].time < cutoff) {
      this.recentHits = this.recentHits.filter((h) => h.time >= cutoff);
    }
  }

  // -------------------------------------------------------------------
  // Rendering support
  // -------------------------------------------------------------------

  /** Latest snapshot at or before `time` (falls back to the live state). */
  public stateAt(time: number): ChamberSnapshot {
    if (!this.running) return this.physics.snapshot();
    let best: ChamberSnapshot | null = null;
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i].time <= time) {
        best = this.snapshots[i];
        break;
      }
    }
    return best ?? this.snapshots[0] ?? this.physics.snapshot();
  }

  /** Hits that became audible within the last FLASH_SECONDS before `time`. */
  public hitsAround(time: number): Array<{ time: number; event: CollisionEvent; track: string; age: number }> {
    return this.recentHits
      .filter((h) => h.time <= time && time - h.time < FLASH_SECONDS)
      .map((h) => ({ ...h, age: time - h.time }));
  }

  public getBalls(): readonly BallState[] {
    return this.physics.getBalls();
  }

  public static defaultPhysics(): ChamberPhysicsConfig {
    return PhysicsChamber.normaliseConfig(DEFAULT_PHYSICS_CONFIG);
  }
}
