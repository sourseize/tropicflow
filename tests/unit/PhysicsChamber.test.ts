import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhysicsChamber, firstRoot } from '../../src/core/physics/PhysicsChamber.ts';
import type { ChamberPhysicsConfig } from '../../src/core/physics/ChamberTypes.ts';

const base: Partial<ChamberPhysicsConfig> = {
  width: 1,
  height: 1,
  gravity: { x: 0, y: 2 },
  restitution: 0.5,
  drag: 0,
  groundFriction: 0,
  pegs: [],
  segments: [],
  balls: [],
  minImpactSpeed: 0.01,
  restSpeed: 0.02,
  removeWhenAsleep: false,
};

test('firstRoot: falling onto a plane', () => {
  // f(t) = 0.5*2*t^2 + 0*t - 0.5 => t = sqrt(0.5)
  const t = firstRoot(2, 0, -0.5, 10);
  assert.ok(t !== null && Math.abs(t - Math.sqrt(0.5)) < 1e-12);
  assert.equal(firstRoot(2, 0, -0.5, 0.1), null); // outside window
  assert.equal(firstRoot(-2, -1, -0.5, 10), null); // moving away, never reaches
  assert.equal(firstRoot(0, 0, 0, 1), null); // resting, no approach
  assert.equal(firstRoot(0, 1, 0, 1), 0); // touching and approaching
});

test('free fall: first floor impact at sqrt(2d/g) and bounces follow the restitution series', () => {
  const r = 0.05;
  const g = 2;
  const e = 0.5;
  const chamber = new PhysicsChamber({ ...base, restitution: e, balls: [{ x: 0.5, y: r, radius: r }] });
  const events = chamber.stepTo(6);
  const floorHits = events.filter((ev) => ev.surfaceId === 'floor');
  assert.ok(floorHits.length >= 5, `got ${floorHits.length} floor hits`);

  const d = 1 - 2 * r;
  const t1 = Math.sqrt((2 * d) / g);
  const v1 = Math.sqrt(2 * g * d);
  assert.ok(Math.abs(floorHits[0].time - t1) < 1e-7, `t1 ${floorHits[0].time} vs ${t1}`);
  assert.ok(Math.abs(floorHits[0].impactSpeed - v1) < 1e-7);

  // Each flight lasts 2 v / g with v multiplied by e every bounce.
  let expected = t1;
  let v = v1 * e;
  for (let i = 1; i < 5; i++) {
    expected += (2 * v) / g;
    assert.ok(Math.abs(floorHits[i].time - expected) < 1e-6, `bounce ${i}: ${floorHits[i].time} vs ${expected}`);
    assert.ok(Math.abs(floorHits[i].impactSpeed - v) < 1e-6);
    v *= e;
  }
  // Only the floor was hit, no spurious surfaces.
  assert.ok(events.every((ev) => ev.surfaceId === 'floor'));
});

test('energy never increases with restitution < 1 and is conserved with restitution 1', () => {
  const energy = (c: PhysicsChamber) => {
    const b = c.getBalls()[0];
    const g = c.getConfig().gravity.y;
    return 0.5 * (b.vx ** 2 + b.vy ** 2) + g * (c.getConfig().height - b.y);
  };
  const lossy = new PhysicsChamber({ ...base, balls: [{ x: 0.3, y: 0.2, vx: 1.5, vy: 0 }] });
  let last = energy(lossy);
  for (let t = 0.05; t <= 4; t += 0.05) {
    lossy.stepTo(t);
    const now = energy(lossy);
    assert.ok(now <= last + 1e-9, `energy rose from ${last} to ${now} at t=${t}`);
    last = now;
  }
  const elastic = new PhysicsChamber({ ...base, restitution: 1, balls: [{ x: 0.3, y: 0.2, vx: 1.5, vy: 0 }] });
  const e0 = energy(elastic);
  elastic.stepTo(3);
  assert.ok(Math.abs(energy(elastic) - e0) < 1e-6 * e0);
});

test('fast balls do not tunnel through pegs or walls', () => {
  const chamber = new PhysicsChamber({
    ...base,
    gravity: { x: 0, y: 0 },
    restitution: 1,
    pegs: [{ id: 'p', x: 0.5, y: 0.5, radius: 0.02, note: 0 }],
    balls: [{ x: 0.1, y: 0.5, vx: 80, vy: 0, radius: 0.01 }], // 80 units/s = 4 cm per 0.5 ms sub-step
  });
  const events = chamber.stepTo(0.05);
  assert.equal(events[0]?.surfaceId, 'p');
  assert.ok(Math.abs(events[0].time - (0.5 - 0.02 - 0.01 - 0.1) / 80) < 1e-9);
  assert.equal(events[1]?.surfaceId, 'left');
  const b = chamber.getBalls()[0];
  assert.ok(b.x >= b.radius - 1e-9 && b.x <= 1 - b.radius + 1e-9);
});

test('peg hits report the peg note and an outward normal', () => {
  const chamber = new PhysicsChamber({
    ...base,
    pegs: [{ id: 'p', x: 0.5, y: 0.6, radius: 0.05, note: 3 }],
    balls: [{ x: 0.5, y: 0.1, radius: 0.03 }],
  });
  const ev = chamber.stepTo(2).find((e) => e.surfaceKind === 'peg')!;
  assert.ok(ev);
  assert.equal(ev.note, 3);
  assert.ok(ev.normal.y < -0.99); // hit from above
  const expected = Math.sqrt((2 * (0.6 - 0.05 - 0.03 - 0.1)) / 2);
  assert.ok(Math.abs(ev.time - expected) < 1e-7, `${ev.time} vs ${expected}`);
});

test('segment (ramp) deflects a ball and reports its note', () => {
  const chamber = new PhysicsChamber({
    ...base,
    segments: [{ id: 's', x1: 0.2, y1: 0.6, x2: 0.8, y2: 0.9, thickness: 0.01, note: 5 }],
    balls: [{ x: 0.4, y: 0.1, radius: 0.03 }],
  });
  const events = chamber.stepTo(3);
  const hit = events.find((e) => e.surfaceKind === 'segment')!;
  assert.ok(hit);
  assert.equal(hit.note, 5);
  assert.ok(hit.normal.y < 0 && hit.normal.x > 0); // ramp descends to the right: normal faces up-right
  // Deflected right and down: right wall, then floor.
  assert.ok(events.some((e) => e.surfaceId === 'right'));
  assert.ok(events.some((e) => e.surfaceId === 'floor' && e.time > hit.time));
});

test('balls bounce off each other when enabled', () => {
  const mk = (on: boolean) =>
    new PhysicsChamber({
      ...base,
      gravity: { x: 0, y: 0 },
      ballCollisions: on,
      balls: [
        { x: 0.2, y: 0.5, vx: 1, vy: 0, radius: 0.03 },
        { x: 0.8, y: 0.5, vx: -1, vy: 0, radius: 0.03 },
      ],
    });
  const on = mk(true);
  const events = on.stepTo(0.5);
  assert.equal(events[0]?.surfaceKind, 'ball');
  assert.ok(Math.abs(events[0].time - (0.6 - 0.06) / 2) < 1e-9);
  const [a, b] = on.getBalls();
  assert.ok(a.vx < 0 && b.vx > 0); // reversed
  const off = mk(false);
  assert.equal(off.stepTo(0.5).length, 0);
});

test('slow contacts do not emit events, resting balls fall asleep and can be removed', () => {
  const chamber = new PhysicsChamber({ ...base, restitution: 0.3, balls: [{ x: 0.5, y: 0.9, radius: 0.05 }] });
  const events = chamber.stepTo(5);
  assert.ok(events.every((e) => e.impactSpeed >= 0.01));
  assert.ok(events.length < 12, `machine-gun: ${events.length} events`);
  assert.equal(chamber.getBalls()[0].asleep, true);
  const removing = new PhysicsChamber({ ...base, restitution: 0.3, removeWhenAsleep: true, balls: [{ x: 0.5, y: 0.9, radius: 0.05 }] });
  removing.stepTo(5);
  assert.equal(removing.getBalls().length, 0);
});

test('same config => identical event stream; setTime re-bases without moving', () => {
  const cfg: Partial<ChamberPhysicsConfig> = {
    ...base,
    pegs: [{ id: 'a', x: 0.4, y: 0.4, radius: 0.04, note: 0 }, { id: 'b', x: 0.6, y: 0.7, radius: 0.04, note: 1 }],
    balls: [{ x: 0.41, y: 0.05, radius: 0.03 }, { x: 0.58, y: 0.05, radius: 0.03 }],
  };
  const a = new PhysicsChamber(cfg).stepTo(4);
  const b = new PhysicsChamber(cfg).stepTo(4);
  assert.deepEqual(a, b);
  assert.ok(a.length > 3);

  const c = new PhysicsChamber(cfg);
  c.setTime(100);
  const shifted = c.stepTo(104);
  assert.equal(shifted.length, a.length);
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(shifted[i].time - 100 - a[i].time) < 1e-9);
});

test('dropBall without x uses the seeded RNG deterministically; maxBalls evicts the oldest', () => {
  const a = new PhysicsChamber({ ...base, seed: 5, maxBalls: 3 });
  const b = new PhysicsChamber({ ...base, seed: 5, maxBalls: 3 });
  for (let i = 0; i < 4; i++) assert.equal(a.dropBall().x, b.dropBall().x);
  assert.equal(a.getBalls().length, 3);
  assert.equal(a.getBalls()[0].id, 2);
});

test('editing helpers: peg notes, segments add/find/remove', () => {
  const chamber = new PhysicsChamber({ ...base, pegs: [{ id: 'p', x: 0.5, y: 0.5, radius: 0.05, note: 0 }] });
  chamber.setPegNote('p', 4);
  assert.equal(chamber.getPegs()[0].note, 4);
  chamber.addSegment({ id: 's', x1: 0.1, y1: 0.8, x2: 0.4, y2: 0.9, thickness: 0.01, note: 2 });
  assert.equal(chamber.findSegmentAt(0.25, 0.85)?.id, 's');
  assert.equal(chamber.findSegmentAt(0.25, 0.7), null);
  chamber.setSegmentNote('s', 7);
  assert.equal(chamber.getSegments()[0].note, 7);
  chamber.removeSegment('s');
  assert.equal(chamber.getSegments().length, 0);
});
