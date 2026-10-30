/**
 * Data model of the Gravity Chamber.
 *
 * Coordinates are normalised: x in [0, width], y in [0, height] with y
 * growing downwards (screen convention). Default gravity points +y. Units are
 * "chamber units" per second; time is audio-context seconds, independent of
 * tempo.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export type WallSide = 'floor' | 'ceiling' | 'left' | 'right';
export type SurfaceKind = 'wall' | 'peg' | 'segment' | 'ball';

export interface Peg {
  id: string;
  x: number;
  y: number;
  radius: number;
  /** Scale degree used by the mapper for pitched instruments. */
  note: number;
}

export interface Segment {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Collision thickness (half-width) of the line. */
  thickness: number;
  note: number;
}

export interface BallState {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  /** Simulation time at which the ball was added. */
  bornAt: number;
  /** True once the ball has come to rest (no longer integrated). */
  asleep: boolean;
}

/** A ball as stored in a config (what to create, not full runtime state). */
export interface BallSpec {
  x: number;
  y: number;
  vx?: number;
  vy?: number;
  radius?: number;
}

export interface CollisionEvent {
  /** Simulation (audio-context) time of the impact, sub-step accurate. */
  time: number;
  ballId: number;
  surfaceKind: SurfaceKind;
  /** Wall side, peg id, segment id or the other ball's id as a string. */
  surfaceId: string;
  side?: WallSide;
  /** Speed component along the contact normal, before the bounce (units/s). */
  impactSpeed: number;
  /** Contact point. */
  position: Vec2;
  /** Unit normal pointing from the surface into the ball. */
  normal: Vec2;
  /** Scale degree of the peg/segment that was hit, if any. */
  note?: number;
}

export interface ChamberPhysicsConfig {
  width: number;
  height: number;
  gravity: Vec2;
  /** Coefficient of restitution 0..1. */
  restitution: number;
  /** Linear air drag per second (0 = none). */
  drag: number;
  /** Tangential velocity kept per second while resting on a surface (0..1). */
  groundFriction: number;
  /** Fixed integration sub-step in seconds. */
  subStep: number;
  /** Collisions slower than this (units/s) are silent contacts, not events. */
  minImpactSpeed: number;
  /** Minimum seconds between two events of the same ball on the same surface. */
  contactRefractory: number;
  /** Normal speed below which a bounce is converted into resting contact. */
  restSpeed: number;
  /** Remove balls once they fall asleep. */
  removeWhenAsleep: boolean;
  /** Balls bounce off each other (discrete resolution at sub-step ends). */
  ballCollisions: boolean;
  maxBalls: number;
  defaultBallRadius: number;
  seed: number;
  pegs: Peg[];
  segments: Segment[];
  balls: BallSpec[];
}

export const DEFAULT_PHYSICS_CONFIG: ChamberPhysicsConfig = {
  width: 1,
  height: 1,
  gravity: { x: 0, y: 2.5 },
  restitution: 0.72,
  drag: 0.02,
  groundFriction: 0.4,
  subStep: 1 / 1000,
  minImpactSpeed: 0.15,
  contactRefractory: 0.02,
  restSpeed: 0.08,
  removeWhenAsleep: true,
  ballCollisions: true,
  maxBalls: 12,
  defaultBallRadius: 0.035,
  seed: 1,
  pegs: [
    { id: 'peg-1', x: 0.3, y: 0.42, radius: 0.04, note: 0 },
    { id: 'peg-2', x: 0.62, y: 0.36, radius: 0.04, note: 2 },
    { id: 'peg-3', x: 0.48, y: 0.68, radius: 0.04, note: 4 },
  ],
  segments: [],
  balls: [],
};

/** Immutable snapshot of the chamber for rendering. */
export interface ChamberSnapshot {
  time: number;
  balls: BallState[];
}
