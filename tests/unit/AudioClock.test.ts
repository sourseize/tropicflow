import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioClock } from '../../src/core/audio/AudioClock.ts';

const collect = (clock: AudioClock) => {
  const fired: Array<{ step: number; time: number }> = [];
  clock.subscribe((step, time) => fired.push({ step, time }));
  return fired;
};

test('steps are spaced exactly 60/bpm/4 seconds apart without swing', () => {
  const clock = new AudioClock({ getTime: () => 0, bpm: 120 });
  const fired = collect(clock);
  clock.reset(1.0);
  clock.advanceSteps(17);
  assert.equal(fired.length, 17);
  for (let i = 0; i < 17; i++) {
    assert.equal(fired[i].step, i % 16);
    assert.ok(Math.abs(fired[i].time - (1.0 + i * 0.125)) < 1e-12, `step ${i} at ${fired[i].time}`);
  }
});

test('swing lengthens even steps and shortens odd steps; pairs sum to two 16ths', () => {
  const clock = new AudioClock({ getTime: () => 0, bpm: 120, swing: 0.3 });
  const fired = collect(clock);
  clock.reset(0);
  clock.advanceSteps(5);
  const d = (i: number) => fired[i + 1].time - fired[i].time;
  assert.ok(Math.abs(d(0) - 0.125 * 1.3) < 1e-12);
  assert.ok(Math.abs(d(1) - 0.125 * 0.7) < 1e-12);
  assert.ok(Math.abs(d(0) + d(1) - 0.25) < 1e-12);
  assert.ok(Math.abs(clock.patternDuration() - 2.0) < 1e-12);
});

test('advanceUntil fires only steps strictly before the horizon and is idempotent', () => {
  const clock = new AudioClock({ getTime: () => 0, bpm: 120 });
  const fired = collect(clock);
  clock.reset(0);
  assert.equal(clock.advanceUntil(0.3), 3); // 0, 0.125, 0.25
  assert.equal(clock.advanceUntil(0.3), 0);
  assert.equal(clock.advanceUntil(0.375), 0); // next step is exactly 0.375: not strictly before
  assert.equal(clock.advanceUntil(0.3751), 1);
  assert.deepEqual(fired.map((f) => f.step), [0, 1, 2, 3]);
});

test('bpm and swing are clamped', () => {
  const clock = new AudioClock({ getTime: () => 0 });
  clock.setBpm(10);
  assert.equal(clock.getBpm(), 40);
  clock.setBpm(999);
  assert.equal(clock.getBpm(), 240);
  clock.setSwing(2);
  assert.equal(clock.getSwing(), 0.5);
});

test('realtime start() schedules ahead of the injected time source and stop() rewinds', async () => {
  let now = 10;
  const clock = new AudioClock({ getTime: () => now, bpm: 240 });
  const fired = collect(clock);
  clock.start();
  assert.ok(clock.getIsPlaying());
  await new Promise((r) => setTimeout(r, 60));
  // First step lands 50 ms after start; the scheduler looks 100 ms ahead.
  assert.ok(fired.length >= 1 && fired[0].time === 10.05, JSON.stringify(fired));
  assert.ok(fired.every((f) => f.time < now + 0.1 + 1e-9));
  now += 0.5;
  await new Promise((r) => setTimeout(r, 60));
  const countAfterAdvance = fired.length;
  assert.ok(countAfterAdvance > 2);
  clock.stop();
  assert.equal(clock.getCurrentStep(), 0);
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fired.length, countAfterAdvance);
});
