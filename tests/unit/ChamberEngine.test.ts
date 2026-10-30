import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChamberEngine, type ChamberNote } from '../../src/core/physics/ChamberEngine.ts';
import { AudioClock } from '../../src/core/audio/AudioClock.ts';

const physics = {
  gravity: { x: 0, y: 2 },
  restitution: 0.5,
  drag: 0,
  groundFriction: 0,
  pegs: [],
  segments: [],
  balls: [],
  minImpactSpeed: 0.05,
  restSpeed: 0.02,
  removeWhenAsleep: false,
  ballCollisions: false,
};

test('runTo schedules a kick at the analytic floor-impact time', () => {
  const notes: ChamberNote[] = [];
  const eng = new ChamberEngine({ physics: { ...physics, balls: [{ x: 0.5, y: 0.05, radius: 0.05 }] } }, { sink: (n) => notes.push(n) });
  eng.start(10);
  eng.runTo(11.5);
  assert.ok(notes.length >= 1);
  const expected = 10 + Math.sqrt((2 * 0.9) / 2);
  assert.equal(notes[0].command.track, 'kick');
  assert.ok(Math.abs(notes[0].time - expected) < 1e-7, `${notes[0].time} vs ${expected}`);
  // Stepping in many small horizons (like the realtime lookahead) gives the same result.
  const notes2: ChamberNote[] = [];
  const eng2 = new ChamberEngine({ physics: { ...physics, balls: [{ x: 0.5, y: 0.05, radius: 0.05 }] } }, { sink: (n) => notes2.push(n) });
  eng2.start(10);
  for (let h = 10.025; h <= 11.5; h += 0.025) eng2.runTo(h);
  assert.deepEqual(notes2.map((n) => n.time), notes.filter((n) => n.time <= 11.5).map((n) => n.time));
});

test('queued drops happen at exactly the requested time', () => {
  const notes: ChamberNote[] = [];
  const eng = new ChamberEngine({ physics: { ...physics, defaultBallRadius: 0.05 }, dropX: 0.5 }, { sink: (n) => notes.push(n) });
  eng.start(0);
  eng.requestDrop(0.75);
  eng.runTo(0.5);
  assert.equal(eng.getBalls().length, 0);
  eng.runTo(2.5);
  assert.equal(eng.getBalls().length, 1);
  const expected = 0.75 + Math.sqrt((2 * 0.9) / 2);
  assert.ok(Math.abs(notes[0].time - expected) < 1e-7, `${notes[0].time} vs ${expected}`);
});

test('autoDropBars drops on the first step of every Nth bar', () => {
  const changed: number[] = [];
  const eng = new ChamberEngine({ physics, autoDropBars: 2, dropX: 0.5 }, { sink: () => {}, onChanged: () => changed.push(eng.physics.getTime()) });
  eng.start(0);
  const clock = new AudioClock({ getTime: () => 0, bpm: 120 });
  clock.subscribe((step, time) => eng.onStep(step, time));
  clock.reset(0);
  clock.advanceSteps(16 * 4); // 4 bars at 2 s each
  eng.runTo(8);
  assert.deepEqual(changed.map((t) => Number(t.toFixed(9))), [0, 4]);
});

test('quantize snaps hits toward the sequencer grid', () => {
  const clock = new AudioClock({ getTime: () => 0, bpm: 120 }); // 16th = 0.125 s
  clock.reset(0);
  clock.advanceSteps(8);
  assert.equal(clock.quantizeTime(0.30, 1), 0.25);
  assert.equal(clock.quantizeTime(0.32, 1), 0.375);
  assert.ok(Math.abs(clock.quantizeTime(0.30, 0.5) - 0.275) < 1e-12);
  assert.equal(clock.quantizeTime(0.30, 0), 0.30);
  assert.equal(clock.quantizeTime(5.01, 1), 5.0); // far beyond the fired steps: grid continues
  assert.equal(clock.quantizeTime(-0.04, 1), 0); // before the start

  const swung = new AudioClock({ getTime: () => 0, bpm: 120, swing: 0.2 });
  swung.reset(0);
  swung.advanceSteps(4);
  assert.ok(Math.abs(swung.quantizeTime(0.16, 1) - 0.15) < 1e-12); // odd step lands at 0.125 * 1.2

  const notes: ChamberNote[] = [];
  const eng = new ChamberEngine(
    { physics: { ...physics, balls: [{ x: 0.5, y: 0.05, radius: 0.05 }] }, quantize: 1 },
    { sink: (n) => notes.push(n), quantizer: (t, s) => clock.quantizeTime(t, s) }
  );
  eng.start(0);
  eng.runTo(1.2);
  assert.ok(Math.abs(notes[0].collision.time - Math.sqrt(0.9)) < 1e-7);
  assert.equal(notes[0].time, 1.0); // sqrt(0.9) = 0.9487 -> nearest 16th is 1.0
});

test('snapshots allow drawing the state at an earlier (audible) time', () => {
  const eng = new ChamberEngine({ physics: { ...physics, balls: [{ x: 0.5, y: 0.05, radius: 0.05 }] } }, { sink: () => {} });
  eng.start(0);
  eng.runTo(0.5);
  const early = eng.stateAt(0.1);
  const late = eng.stateAt(0.5);
  assert.ok(early.time <= 0.1 && early.time > 0.08);
  assert.ok(late.balls[0].y > early.balls[0].y);
  assert.ok(Math.abs(early.balls[0].y - (0.05 + 0.5 * 2 * early.time ** 2)) < 1e-9);
});

test('exportConfig round-trips into an identical simulation', () => {
  const a = new ChamberEngine({ physics: { ...physics, balls: [{ x: 0.3, y: 0.1, vx: 0.4 }, { x: 0.7, y: 0.2 }] } }, { sink: () => {} });
  a.start(0);
  a.runTo(0.4);
  const exported = a.exportConfig();
  const notesA: number[] = [];
  const notesB: number[] = [];
  a['deps'].sink = (n) => notesA.push(n.time);
  const b = new ChamberEngine(exported, { sink: (n) => notesB.push(n.time + 0.4) });
  b.start(0);
  a.runTo(3);
  b.runTo(2.6);
  assert.ok(notesA.length > 2);
  assert.deepEqual(notesB.map((t) => Number(t.toFixed(9))), notesA.map((t) => Number(t.toFixed(9))));
});

test("dropSync 'bar' holds manual drops until the next bar start while playing", () => {
  const eng = new ChamberEngine({ physics, dropSync: 'bar', dropX: 0.5 }, { sink: () => {} });
  eng.requestDrop(); // stopped: immediate
  assert.equal(eng.getBalls().length, 1);
  eng.clearBalls();
  eng.start(0);
  eng.requestDrop();
  eng.requestDrop(undefined, 0.2);
  assert.equal(eng.getBalls().length, 0);
  assert.equal(eng.pendingBarDropCount(), 2);
  eng.runTo(0.5);
  assert.equal(eng.getBalls().length, 0);
  eng.onStep(3, 0.375); // not a bar start
  assert.equal(eng.pendingBarDropCount(), 2);
  eng.onStep(0, 2.0);
  eng.runTo(2.5);
  assert.equal(eng.pendingBarDropCount(), 0);
  const xs = eng.getBalls().map((b) => b.x).sort();
  assert.deepEqual(xs, [0.2, 0.5]);
  for (const b of eng.getBalls()) assert.ok(Math.abs(b.bornAt - 2.0) < 1e-9);
});

test('updateMapping changes what collisions play; loadConfig replaces everything', () => {
  const notes: ChamberNote[] = [];
  const eng = new ChamberEngine({ physics: { ...physics, balls: [{ x: 0.5, y: 0.05, radius: 0.05 }] } }, { sink: (n) => notes.push(n) });
  eng.updateMapping({ floor: { track: 'snare' } });
  eng.start(0);
  eng.runTo(1.2);
  assert.equal(notes[0].command.track, 'snare');

  eng.loadConfig({ physics: { ...physics, pegs: [{ id: 'p', x: 0.5, y: 0.5, radius: 0.05, note: 1 }], balls: [] } });
  assert.equal(eng.getBalls().length, 0);
  assert.equal(eng.physics.getPegs().length, 1);
  assert.equal(eng.getConfig().mapping.floor.track, 'kick'); // mapping reset to defaults
  assert.ok(Math.abs(eng.physics.getTime() - 1.2) < 1e-9, 'keeps the running clock aligned');
});
