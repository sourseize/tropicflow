import { SeededRandom } from '../util/SeededRandom.ts';
import {
  type BallSpec,
  type BallState,
  type ChamberPhysicsConfig,
  type ChamberSnapshot,
  type CollisionEvent,
  DEFAULT_PHYSICS_CONFIG,
  type Peg,
  type Segment,
  type SurfaceKind,
  type Vec2,
  type WallSide,
} from './ChamberTypes.ts';

const EPS = 1e-9;
const CONTACT_EPS = 1e-6;
const MAX_BOUNCES_PER_STEP = 6;

interface Hit {
  t: number;
  surfaceKind: SurfaceKind;
  surfaceId: string;
  side?: WallSide;
  normal: Vec2;
  note?: number;
  otherBall?: BallState;
}

interface Contact {
  surfaceKind: SurfaceKind;
  surfaceId: string;
  normal: Vec2;
}

const FLOOR_CONTACT: Contact = { surfaceKind: 'wall', surfaceId: 'floor', normal: { x: 0, y: -1 } };
const CEILING_CONTACT: Contact = { surfaceKind: 'wall', surfaceId: 'ceiling', normal: { x: 0, y: 1 } };
const LEFT_CONTACT: Contact = { surfaceKind: 'wall', surfaceId: 'left', normal: { x: 1, y: 0 } };
const RIGHT_CONTACT: Contact = { surfaceKind: 'wall', surfaceId: 'right', normal: { x: -1, y: 0 } };

/**
 * Deterministic 2-D ball simulation with sub-step-accurate collision times.
 *
 * Integration uses a fixed sub-step. Inside a sub-step motion is exact for
 * constant acceleration (p += v t + a t^2 / 2), and the time of impact with
 * walls (quadratic), pegs/segments/other balls (sampled + bisection) is solved
 * analytically so a collision's `time` is precise to ~1e-9 s rather than
 * quantised to the sub-step. The same config and calls always yield the same
 * events (no wall-clock dependence, seeded randomness only).
 */
export class PhysicsChamber {
  private config: ChamberPhysicsConfig;
  private time: number = 0;
  private balls: BallState[] = [];
  private nextBallId: number = 1;
  private readonly lastContact: Map<string, number> = new Map();
  private rng: SeededRandom;

  constructor(config: Partial<ChamberPhysicsConfig> = {}) {
    this.config = PhysicsChamber.normaliseConfig(config);
    this.rng = new SeededRandom(this.config.seed);
    for (const spec of this.config.balls) this.addBall(spec);
  }

  public static normaliseConfig(config: Partial<ChamberPhysicsConfig>): ChamberPhysicsConfig {
    return {
      ...DEFAULT_PHYSICS_CONFIG,
      ...config,
      gravity: { ...(config.gravity ?? DEFAULT_PHYSICS_CONFIG.gravity) },
      pegs: (config.pegs ?? DEFAULT_PHYSICS_CONFIG.pegs).map((p) => ({ ...p })),
      segments: (config.segments ?? DEFAULT_PHYSICS_CONFIG.segments).map((s) => ({ ...s })),
      balls: (config.balls ?? DEFAULT_PHYSICS_CONFIG.balls).map((b) => ({ ...b })),
    };
  }

  // -------------------------------------------------------------------
  // State access
  // -------------------------------------------------------------------

  public getTime(): number {
    return this.time;
  }

  /** Re-base the simulation clock without moving anything. */
  public setTime(time: number): void {
    const delta = time - this.time;
    this.time = time;
    for (const b of this.balls) b.bornAt += delta;
    for (const [k, v] of this.lastContact) this.lastContact.set(k, v + delta);
  }

  public getConfig(): Readonly<ChamberPhysicsConfig> {
    return this.config;
  }

  /** Update tunable parameters (geometry lists are replaced when given). */
  public updateConfig(patch: Partial<ChamberPhysicsConfig>): void {
    this.config = PhysicsChamber.normaliseConfig({ ...this.config, ...patch, balls: [] });
    if (patch.seed !== undefined) this.rng = new SeededRandom(patch.seed);
  }

  public getBalls(): readonly BallState[] {
    return this.balls;
  }

  public getPegs(): readonly Peg[] {
    return this.config.pegs;
  }

  public getSegments(): readonly Segment[] {
    return this.config.segments;
  }

  public snapshot(): ChamberSnapshot {
    return { time: this.time, balls: this.balls.map((b) => ({ ...b })) };
  }

  /** Config reflecting the current geometry and ball state (for bounce/serialisation). */
  public exportConfig(): ChamberPhysicsConfig {
    return {
      ...this.config,
      gravity: { ...this.config.gravity },
      pegs: this.config.pegs.map((p) => ({ ...p })),
      segments: this.config.segments.map((s) => ({ ...s })),
      balls: this.balls.filter((b) => !b.asleep).map((b) => ({ x: b.x, y: b.y, vx: b.vx, vy: b.vy, radius: b.radius })),
    };
  }

  // -------------------------------------------------------------------
  // Editing
  // -------------------------------------------------------------------

  public addBall(spec: BallSpec): BallState {
    const radius = spec.radius ?? this.config.defaultBallRadius;
    const ball: BallState = {
      id: this.nextBallId++,
      x: clamp(spec.x, radius, this.config.width - radius),
      y: clamp(spec.y, radius, this.config.height - radius),
      vx: spec.vx ?? 0,
      vy: spec.vy ?? 0,
      radius,
      bornAt: this.time,
      asleep: false,
    };
    this.balls.push(ball);
    while (this.balls.length > this.config.maxBalls) this.balls.shift();
    return ball;
  }

  /** Drop a ball from the ceiling at `x` (random x when omitted). */
  public dropBall(x?: number, radius?: number): BallState {
    const r = radius ?? this.config.defaultBallRadius;
    const px = x ?? this.rng.range(r, this.config.width - r);
    return this.addBall({ x: px, y: r, radius: r });
  }

  public removeBall(id: number): void {
    this.balls = this.balls.filter((b) => b.id !== id);
  }

  public clearBalls(): void {
    this.balls = [];
    this.lastContact.clear();
  }

  public addPeg(peg: Peg): void {
    this.config.pegs.push({ ...peg });
  }

  public removePeg(id: string): void {
    this.config.pegs = this.config.pegs.filter((p) => p.id !== id);
  }

  public movePeg(id: string, x: number, y: number): void {
    const peg = this.config.pegs.find((p) => p.id === id);
    if (!peg) return;
    peg.x = clamp(x, peg.radius, this.config.width - peg.radius);
    peg.y = clamp(y, peg.radius, this.config.height - peg.radius);
  }

  public setPegNote(id: string, note: number): void {
    const peg = this.config.pegs.find((p) => p.id === id);
    if (peg) peg.note = note;
  }

  public addSegment(seg: Segment): void {
    this.config.segments.push({ ...seg });
  }

  public removeSegment(id: string): void {
    this.config.segments = this.config.segments.filter((s) => s.id !== id);
  }

  public setSegmentNote(id: string, note: number): void {
    const seg = this.config.segments.find((s) => s.id === id);
    if (seg) seg.note = note;
  }

  /** Segment whose capsule (thickness + `slack`) contains the point. */
  public findSegmentAt(x: number, y: number, slack: number = 0.015): Segment | null {
    for (const seg of this.config.segments) {
      const cp = closestPointOnSegment(x, y, seg);
      const reach = seg.thickness + slack;
      if ((x - cp.x) ** 2 + (y - cp.y) ** 2 <= reach * reach) return seg;
    }
    return null;
  }

  public findPegAt(x: number, y: number): Peg | null {
    for (const p of this.config.pegs) {
      if ((p.x - x) ** 2 + (p.y - y) ** 2 <= p.radius ** 2) return p;
    }
    return null;
  }

  // -------------------------------------------------------------------
  // Simulation
  // -------------------------------------------------------------------

  /** Advance the simulation to `target` seconds, returning collisions in time order. */
  public stepTo(target: number): CollisionEvent[] {
    const events: CollisionEvent[] = [];
    const { subStep } = this.config;
    while (target - this.time > EPS) {
      const dt = Math.min(subStep, target - this.time);
      for (const ball of this.balls) {
        if (!ball.asleep) this.advanceBall(ball, dt, events);
      }
      this.time += dt;
      if (this.config.removeWhenAsleep) this.balls = this.balls.filter((b) => !b.asleep);
    }
    events.sort((a, b) => a.time - b.time);
    return events;
  }

  private advanceBall(ball: BallState, dt: number, events: CollisionEvent[]): void {
    let remaining = dt;
    let bounces = 0;
    const start = this.time;

    while (remaining > EPS) {
      const contacts = this.restingContacts(ball);
      const accel = this.effectiveAcceleration(ball, contacts);
      const hit = this.earliestHit(ball, accel, remaining, contacts);

      if (!hit) {
        this.move(ball, accel, remaining);
        remaining = 0;
        break;
      }

      this.move(ball, accel, hit.t);
      remaining -= hit.t;
      this.resolveHit(ball, hit, start + (dt - remaining), events);

      if (++bounces >= MAX_BOUNCES_PER_STEP) {
        // Wedged in a corner: stop it rather than loop.
        ball.vx = 0;
        ball.vy = 0;
        break;
      }
    }

    const dragFactor = Math.exp(-this.config.drag * dt);
    ball.vx *= dragFactor;
    ball.vy *= dragFactor;

    const contacts = this.restingContacts(ball);
    if (contacts.length > 0) {
      const frictionFactor = Math.exp(-this.config.groundFriction * dt);
      ball.vx *= frictionFactor;
      ball.vy *= frictionFactor;
      const speed = Math.hypot(ball.vx, ball.vy);
      const onFloorLike = contacts.some((c) => c.normal.y < -0.5);
      if (onFloorLike && speed < this.config.restSpeed * 0.5) {
        ball.asleep = true;
        ball.vx = 0;
        ball.vy = 0;
      }
    }
  }

  private move(ball: BallState, a: Vec2, t: number): void {
    ball.x += ball.vx * t + 0.5 * a.x * t * t;
    ball.y += ball.vy * t + 0.5 * a.y * t * t;
    ball.vx += a.x * t;
    ball.vy += a.y * t;
  }

  /**
   * Surfaces the ball is resting on: touching, not bouncing (normal speed
   * below restSpeed) and being pushed into the surface by gravity. A ball
   * touching a surface that gravity pulls it away from (e.g. just dropped
   * from the ceiling) is not resting and must be left free to leave.
   */
  private readonly scratchResting: Contact[] = [];

  private restingContacts(ball: BallState): Contact[] {
    const out = this.scratchResting;
    out.length = 0;
    const { restSpeed, gravity } = this.config;
    const touching = this.touchingSurfaces(ball);
    for (let i = 0; i < touching.length; i++) {
      const c = touching[i];
      const vn = ball.vx * c.normal.x + ball.vy * c.normal.y;
      const an = gravity.x * c.normal.x + gravity.y * c.normal.y;
      if (vn >= restSpeed) continue; // leaving
      if (vn <= -restSpeed) continue; // impact: handled by the hit search at t = 0
      if (vn < 0) {
        // Creeping inwards: cancel the residual normal velocity.
        ball.vx -= vn * c.normal.x;
        ball.vy -= vn * c.normal.y;
      }
      if (an < 0) out.push(c);
    }
    return out;
  }

  private readonly scratchContacts: Contact[] = [];

  /** Surfaces within CONTACT_EPS of the ball. Returns a reused scratch array. */
  private touchingSurfaces(ball: BallState): Contact[] {
    const { width, height } = this.config;
    const out = this.scratchContacts;
    out.length = 0;
    const r = ball.radius;
    if (ball.y + r >= height - CONTACT_EPS) out.push(FLOOR_CONTACT);
    if (ball.y - r <= CONTACT_EPS) out.push(CEILING_CONTACT);
    if (ball.x - r <= CONTACT_EPS) out.push(LEFT_CONTACT);
    if (ball.x + r >= width - CONTACT_EPS) out.push(RIGHT_CONTACT);
    const pegs = this.config.pegs;
    for (let i = 0; i < pegs.length; i++) {
      const peg = pegs[i];
      const dx = ball.x - peg.x;
      const dy = ball.y - peg.y;
      const reach = peg.radius + r + CONTACT_EPS;
      if (dx * dx + dy * dy > reach * reach) continue;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 0) out.push({ surfaceKind: 'peg', surfaceId: peg.id, normal: { x: dx / d, y: dy / d } });
    }
    const segs = this.config.segments;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const cp = closestPointOnSegment(ball.x, ball.y, seg);
      const dx = ball.x - cp.x;
      const dy = ball.y - cp.y;
      const reach = seg.thickness + r + CONTACT_EPS;
      if (dx * dx + dy * dy > reach * reach) continue;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 0) out.push({ surfaceKind: 'segment', surfaceId: seg.id, normal: { x: dx / d, y: dy / d } });
    }
    return out;
  }

  private effectiveAcceleration(_ball: BallState, contacts: Contact[]): Vec2 {
    const a = { x: this.config.gravity.x, y: this.config.gravity.y };
    for (const c of contacts) {
      const an = a.x * c.normal.x + a.y * c.normal.y;
      if (an < 0) {
        a.x -= an * c.normal.x;
        a.y -= an * c.normal.y;
      }
    }
    return a;
  }

  private earliestHit(ball: BallState, a: Vec2, tmax: number, resting: Contact[]): Hit | null {
    const { width, height } = this.config;
    const r = ball.radius;
    let restFloor = false;
    let restCeil = false;
    let restLeft = false;
    let restRight = false;
    for (let i = 0; i < resting.length; i++) {
      const id = resting[i].surfaceId;
      if (id === 'floor') restFloor = true;
      else if (id === 'ceiling') restCeil = true;
      else if (id === 'left') restLeft = true;
      else if (id === 'right') restRight = true;
    }
    const isResting = (id: string) => {
      for (let i = 0; i < resting.length; i++) if (resting[i].surfaceId === id) return true;
      return false;
    };

    let bestT = Infinity;
    let bestKind: SurfaceKind = 'wall';
    let bestId = '';
    let bestSide: WallSide | undefined;
    let nx = 0;
    let ny = 0;
    let bestNote: number | undefined;
    let bestOther: BallState | undefined;

    // Walls: penetration f(t) = 0.5 A t^2 + B t + C crossing zero while increasing.
    if (!restFloor) {
      const t = firstRoot(a.y, ball.vy, ball.y + r - height, tmax);
      if (t !== null && t < bestT) { bestT = t; bestKind = 'wall'; bestId = 'floor'; bestSide = 'floor'; nx = 0; ny = -1; }
    }
    if (!restCeil) {
      const t = firstRoot(-a.y, -ball.vy, r - ball.y, tmax);
      if (t !== null && t < bestT) { bestT = t; bestKind = 'wall'; bestId = 'ceiling'; bestSide = 'ceiling'; nx = 0; ny = 1; }
    }
    if (!restLeft) {
      const t = firstRoot(-a.x, -ball.vx, r - ball.x, tmax);
      if (t !== null && t < bestT) { bestT = t; bestKind = 'wall'; bestId = 'left'; bestSide = 'left'; nx = 1; ny = 0; }
    }
    if (!restRight) {
      const t = firstRoot(a.x, ball.vx, ball.x + r - width, tmax);
      if (t !== null && t < bestT) { bestT = t; bestKind = 'wall'; bestId = 'right'; bestSide = 'right'; nx = -1; ny = 0; }
    }

    // Pegs and other balls: circle vs moving circle.
    const pegs = this.config.pegs;
    for (let i = 0; i < pegs.length; i++) {
      const peg = pegs[i];
      if (resting.length && isResting(peg.id)) continue;
      const t = circleCrossing(ball, a, peg.x, peg.y, peg.radius + r, Math.min(tmax, bestT));
      if (t >= 0 && t < bestT) {
        bestT = t;
        bestKind = 'peg';
        bestId = peg.id;
        bestSide = undefined;
        bestNote = peg.note;
        bestOther = undefined;
        const px = ball.x + ball.vx * t + 0.5 * a.x * t * t - peg.x;
        const py = ball.y + ball.vy * t + 0.5 * a.y * t * t - peg.y;
        const d = Math.sqrt(px * px + py * py) || 1;
        nx = px / d;
        ny = py / d;
      }
    }
    if (this.config.ballCollisions) {
      const balls = this.balls;
      for (let i = 0; i < balls.length; i++) {
        const other = balls[i];
        if (other === ball) continue;
        const t = circleCrossing(ball, a, other.x, other.y, other.radius + r, Math.min(tmax, bestT));
        if (t >= 0 && t < bestT) {
          bestT = t;
          bestKind = 'ball';
          bestId = String(other.id);
          bestSide = undefined;
          bestNote = undefined;
          bestOther = other;
          const px = ball.x + ball.vx * t + 0.5 * a.x * t * t - other.x;
          const py = ball.y + ball.vy * t + 0.5 * a.y * t * t - other.y;
          const d = Math.sqrt(px * px + py * py) || 1;
          nx = px / d;
          ny = py / d;
        }
      }
    }

    // Segments (capsules).
    const segs = this.config.segments;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (resting.length && isResting(seg.id)) continue;
      const R = seg.thickness + r;
      const f = (t: number) => {
        const px = ball.x + ball.vx * t + 0.5 * a.x * t * t;
        const py = ball.y + ball.vy * t + 0.5 * a.y * t * t;
        const cp = closestPointOnSegment(px, py, seg);
        return R * R - ((px - cp.x) ** 2 + (py - cp.y) ** 2);
      };
      const t = firstCrossing(f, Math.min(tmax, bestT));
      if (t !== null && t < bestT) {
        bestT = t;
        bestKind = 'segment';
        bestId = seg.id;
        bestSide = undefined;
        bestNote = seg.note;
        bestOther = undefined;
        const px = ball.x + ball.vx * t + 0.5 * a.x * t * t;
        const py = ball.y + ball.vy * t + 0.5 * a.y * t * t;
        const cp = closestPointOnSegment(px, py, seg);
        const d = Math.sqrt((px - cp.x) ** 2 + (py - cp.y) ** 2) || 1;
        nx = (px - cp.x) / d;
        ny = (py - cp.y) / d;
      }
    }

    if (bestT === Infinity) return null;
    return { t: bestT, surfaceKind: bestKind, surfaceId: bestId, side: bestSide, normal: { x: nx, y: ny }, note: bestNote, otherBall: bestOther };
  }

  private resolveHit(ball: BallState, hit: Hit, time: number, events: CollisionEvent[]): void {
    const n = hit.normal;
    const { restitution, restSpeed, minImpactSpeed } = this.config;

    // Snap exactly onto the surface to avoid drift.
    this.snapToSurface(ball, hit);

    if (hit.otherBall) {
      const other = hit.otherBall;
      const rvx = ball.vx - other.vx;
      const rvy = ball.vy - other.vy;
      const vn = rvx * n.x + rvy * n.y;
      if (vn >= 0) return; // separating
      const impact = -vn;
      const j = ((1 + restitution) / 2) * vn;
      ball.vx -= j * n.x;
      ball.vy -= j * n.y;
      other.vx += j * n.x;
      other.vy += j * n.y;
      if (other.asleep) other.asleep = false;
      const key = ball.id < other.id ? `${ball.id}:${other.id}` : `${other.id}:${ball.id}`;
      this.emit(events, key, time, impact, ball, hit);
      return;
    }

    const vn = ball.vx * n.x + ball.vy * n.y;
    if (vn >= 0) return; // already moving away
    const impact = -vn;

    if (impact < restSpeed) {
      // Too slow to bounce: rest on the surface.
      ball.vx -= vn * n.x;
      ball.vy -= vn * n.y;
      return;
    }

    ball.vx -= (1 + restitution) * vn * n.x;
    ball.vy -= (1 + restitution) * vn * n.y;

    if (impact >= minImpactSpeed) {
      this.emit(events, `${ball.id}:${hit.surfaceId}`, time, impact, ball, hit);
    }
  }

  private emit(events: CollisionEvent[], key: string, time: number, impact: number, ball: BallState, hit: Hit): void {
    const last = this.lastContact.get(key);
    if (last !== undefined && time - last < this.config.contactRefractory) return;
    this.lastContact.set(key, time);
    events.push({
      time,
      ballId: ball.id,
      surfaceKind: hit.surfaceKind,
      surfaceId: hit.surfaceId,
      side: hit.side,
      impactSpeed: impact,
      position: { x: ball.x - hit.normal.x * ball.radius, y: ball.y - hit.normal.y * ball.radius },
      normal: { ...hit.normal },
      note: hit.note,
    });
  }

  private snapToSurface(ball: BallState, hit: Hit): void {
    const { width, height } = this.config;
    const r = ball.radius;
    switch (hit.surfaceKind) {
      case 'wall':
        if (hit.side === 'floor') ball.y = height - r;
        else if (hit.side === 'ceiling') ball.y = r;
        else if (hit.side === 'left') ball.x = r;
        else ball.x = width - r;
        return;
      case 'peg': {
        const peg = this.config.pegs.find((p) => p.id === hit.surfaceId);
        if (!peg) return;
        ball.x = peg.x + hit.normal.x * (peg.radius + r);
        ball.y = peg.y + hit.normal.y * (peg.radius + r);
        return;
      }
      case 'segment': {
        const seg = this.config.segments.find((s) => s.id === hit.surfaceId);
        if (!seg) return;
        const cp = closestPointOnSegment(ball.x, ball.y, seg);
        ball.x = cp.x + hit.normal.x * (seg.thickness + r);
        ball.y = cp.y + hit.normal.y * (seg.thickness + r);
        return;
      }
      case 'ball': {
        const other = hit.otherBall!;
        ball.x = other.x + hit.normal.x * (other.radius + r);
        ball.y = other.y + hit.normal.y * (other.radius + r);
        return;
      }
    }
  }
}

// -----------------------------------------------------------------------
// Geometry helpers
// -----------------------------------------------------------------------

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function closestPointOnSegment(px: number, py: number, seg: Segment): Vec2 {
  const dx = seg.x2 - seg.x1;
  const dy = seg.y2 - seg.y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { x: seg.x1, y: seg.y1 };
  const u = clamp(((px - seg.x1) * dx + (py - seg.y1) * dy) / len2, 0, 1);
  return { x: seg.x1 + u * dx, y: seg.y1 + u * dy };
}

/**
 * Smallest t in [0, tmax] where f(t) = 0.5 A t^2 + B t + C reaches zero from
 * below while increasing (f' = A t + B > 0), i.e. the moment a penetration
 * measure becomes positive. Returns null when there is no such crossing.
 * If C > 0 already (penetrating) and approaching, returns 0.
 */
export function firstRoot(A: number, B: number, C: number, tmax: number): number | null {
  if (C >= -EPS) {
    // Touching or penetrating: it's a hit only if moving inwards.
    return B > EPS ? 0 : null;
  }
  let t: number | null = null;
  if (Math.abs(A) < 1e-12) {
    if (B > EPS) t = -C / B;
  } else {
    const disc = B * B - 2 * A * C;
    if (disc < 0) return null;
    const sq = Math.sqrt(disc);
    const r1 = (-B - sq) / A;
    const r2 = (-B + sq) / A;
    for (const root of r1 < r2 ? [r1, r2] : [r2, r1]) {
      if (root >= -EPS && A * root + B > 0) {
        t = Math.max(0, root);
        break;
      }
    }
  }
  if (t === null || t > tmax) return null;
  return t;
}

/**
 * Time in [0, tmax] at which a ball moving under constant acceleration first
 * comes within distance R of the point (cx, cy); -1 when it does not. Same
 * sampling + bisection scheme as firstCrossing, without closures (hot path).
 */
export function circleCrossing(ball: BallState, a: Vec2, cx: number, cy: number, R: number, tmax: number): number {
  if (!(tmax > 0)) return -1;
  const x0 = ball.x - cx;
  const y0 = ball.y - cy;
  const R2 = R * R;
  // Cheap reject: farther than the ball can travel in tmax (+ margin).
  const speed = Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy) + Math.sqrt(a.x * a.x + a.y * a.y) * tmax;
  const dist = Math.sqrt(x0 * x0 + y0 * y0);
  if (dist - R > speed * tmax + 1e-9) return -1;

  const f = (t: number) => {
    const px = x0 + ball.vx * t + 0.5 * a.x * t * t;
    const py = y0 + ball.vy * t + 0.5 * a.y * t * t;
    return R2 - (px * px + py * py);
  };
  const f0 = f(0);
  if (f0 > EPS) return f(Math.min(tmax, 1e-7)) > f0 ? 0 : -1;
  let lo = 0;
  let hi = -1;
  const half = tmax / 2;
  if (f(half) > 0) hi = half;
  else if (f(tmax) > 0) {
    lo = half;
    hi = tmax;
  }
  if (hi < 0) return -1;
  for (let i = 0; i < 40; i++) {
    const mid: number = 0.5 * (lo + hi);
    if (f(mid) > 0) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * First t in (0, tmax] where the penetration function f crosses from <= 0 to
 * > 0. Samples the end and midpoint, then bisects. Returns 0 if already
 * penetrating and increasing.
 */
export function firstCrossing(f: (t: number) => number, tmax: number): number | null {
  const f0 = f(0);
  if (f0 > EPS) {
    // Already overlapping: hit now only if getting deeper.
    return f(Math.min(tmax, 1e-7)) > f0 ? 0 : null;
  }
  let lo = 0;
  let hi = -1;
  const half = tmax / 2;
  if (f(half) > 0) hi = half;
  else if (f(tmax) > 0) {
    lo = half;
    hi = tmax;
  }
  if (hi < 0) return null;
  for (let i = 0; i < 40; i++) {
    const mid: number = 0.5 * (lo + hi);
    if (f(mid) > 0) hi = mid;
    else lo = mid;
  }
  return hi;
}
