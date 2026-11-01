import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_INPUT_LATENCY, TimestampMapper } from '../../src/core/input/TimestampMapper.ts';

test('without a sample events are scheduled at now + latency', () => {
  const m = new TimestampMapper();
  assert.equal(m.hasSample(), false);
  assert.equal(m.toContextTime(1000), null);
  assert.equal(m.scheduleTime(1000, 5), 5 + DEFAULT_INPUT_LATENCY);
  assert.equal(m.scheduleTime(1000, 5, 0.05), 5.05);
});

test('the {0, 0} sample Chromium returns before rendering is rejected; non-finite too', () => {
  const m = new TimestampMapper();
  assert.equal(m.update({ contextTime: 0, performanceTime: 0 }), false);
  assert.equal(m.update({ contextTime: 1, performanceTime: NaN }), false);
  assert.equal(m.update(null), false);
  assert.equal(m.update(undefined), false);
  assert.equal(m.hasSample(), false);
  assert.equal(m.update({ contextTime: 0.24, performanceTime: 735.2 }), true);
  assert.deepEqual(m.getSample(), { contextTime: 0.24, performanceTime: 735.2 });
});

test('maps a performance timestamp linearly through the sample', () => {
  const m = new TimestampMapper();
  m.update({ contextTime: 10, performanceTime: 5000 });
  assert.ok(Math.abs(m.toContextTime(5000)! - 10) < 1e-12);
  assert.ok(Math.abs(m.toContextTime(5250)! - 10.25) < 1e-12);
  assert.ok(Math.abs(m.toContextTime(4000)! - 9) < 1e-12);
  assert.ok(Math.abs(m.offset()! - 5) < 1e-12);
});

test('a stale sample (smaller offset) within the window is outvoted by the freshest relation', () => {
  const m = new TimestampMapper();
  m.update({ contextTime: 10, performanceTime: 5000 }); // offset 5.000
  m.update({ contextTime: 10.07, performanceTime: 5100 }); // stale by 30 ms: offset 4.970
  assert.ok(Math.abs(m.offset()! - 5) < 1e-12, 'the larger offset wins');
  assert.ok(Math.abs(m.toContextTime(5100)! - 10.1) < 1e-12);
  assert.deepEqual(m.getSample(), { contextTime: 10.07, performanceTime: 5100 }, 'raw latest sample is still reported');
  // Consistent samples keep the estimate; a slightly larger one (it was the stale one before) is adopted.
  m.update({ contextTime: 10.2005, performanceTime: 5200 });
  assert.ok(Math.abs(m.offset()! - 5.0005) < 1e-12);
});

test('samples expire after the window, and a sharp drop (context suspended) resets the estimate', () => {
  const m = new TimestampMapper(1000);
  m.update({ contextTime: 10, performanceTime: 5000 }); // offset 5
  m.update({ contextTime: 10.969, performanceTime: 5990 }); // offset 4.979 (within the drop threshold)
  assert.ok(Math.abs(m.offset()! - 5) < 1e-12, 'the old sample still votes');
  m.update({ contextTime: 10.969 + 0.5, performanceTime: 6490 }); // offset 4.979; the first sample is > 1 s old now
  assert.ok(Math.abs(m.offset()! - 4.979) < 1e-12, 'expired sample no longer votes');
  // Context suspended for 2 s: contextTime stood still while performance time advanced.
  m.update({ contextTime: 11.5, performanceTime: 8520 }); // offset 2.98
  assert.ok(Math.abs(m.offset()! - 2.98) < 1e-12, 'reset to the new relation immediately');
  assert.ok(Math.abs(m.toContextTime(8520)! - 11.5) < 1e-12);
});

test('scheduleTime adds a constant latency and never schedules in the past', () => {
  const m = new TimestampMapper();
  m.update({ contextTime: 10, performanceTime: 5000 });
  // Event 10 ms ago in performance time, now = 10.012: mapped 10.01 + 0.02 = 10.03 > now.
  assert.ok(Math.abs(m.scheduleTime(5010, 10.012) - 10.03) < 1e-12);
  // Two events 5 ms apart keep exactly 5 ms between them (jitter-free).
  const a = m.scheduleTime(5010, 10.012);
  const b = m.scheduleTime(5015, 10.0125);
  assert.ok(Math.abs(b - a - 0.005) < 1e-12);
  // A very late main thread: the event would be in the past, so it is clamped to now.
  assert.equal(m.scheduleTime(5010, 10.2), 10.2);
});
