import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SeededRandom } from '../../src/core/util/SeededRandom.ts';

test('same seed produces the same sequence', () => {
  const a = new SeededRandom(42);
  const b = new SeededRandom(42);
  for (let i = 0; i < 1000; i++) assert.equal(a.next(), b.next());
});

test('different seeds produce different sequences', () => {
  const a = new SeededRandom(1);
  const b = new SeededRandom(2);
  let same = 0;
  for (let i = 0; i < 100; i++) if (a.next() === b.next()) same++;
  assert.ok(same < 5);
});

test('values are uniform in [0,1) and bipolar in [-1,1)', () => {
  const r = new SeededRandom(7);
  let sum = 0;
  const n = 20000;
  for (let i = 0; i < n; i++) {
    const v = r.next();
    assert.ok(v >= 0 && v < 1);
    sum += v;
    const b = r.bipolar();
    assert.ok(b >= -1 && b < 1);
  }
  assert.ok(Math.abs(sum / n - 0.5) < 0.01, `mean ${sum / n}`);
});
