import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stairsLayout } from '../../src/core/graph/StairsLayout.ts';

const cards = (n: number, width = 288) => Array.from({ length: n }, (_, i) => ({ id: `n${i}`, width }));

test('one column when the height allows: each row one step down, last card flush with the right margin', () => {
  const layout = stairsLayout(cards(8), 1500, 620, 36);
  const pos = [...layout.values()];
  assert.equal(pos.length, 8);
  for (let i = 0; i < 8; i++) assert.equal(pos[i].y, 50 + i * 36);
  assert.equal(pos[0].x, 30);
  assert.equal(pos[7].x + 288, 1500 - 30);
  const steps = pos.slice(1).map((p, i) => p.x - pos[i].x);
  assert.ok(steps.every((s) => Math.abs(s - steps[0]) <= 1), 'even steps');
});

test('too little height -> several balanced columns, each spanning its own width', () => {
  // 620 - 50 - 16 = 554 px -> 3 rows of 180 px fit; 8 cards -> 3 columns of 3/3/2.
  const layout = stairsLayout(cards(8), 1500, 620, 180);
  const pos = [...layout.values()];
  const colWidth = (1500 - 60) / 3;
  assert.deepEqual(pos.slice(0, 3).map((p) => p.y), [50, 230, 410]);
  assert.equal(pos[0].x, 30);
  assert.equal(pos[2].x + 288, Math.round(30 + colWidth));
  assert.equal(pos[3].x, Math.round(30 + colWidth), 'second column starts where the first ends');
  assert.deepEqual(pos.slice(6).map((p) => p.y), [50, 230], 'last column has the remaining two');
  assert.equal(pos[7].x + 288, Math.round(30 + 3 * colWidth));
});

test('cards never step backwards when the column is narrower than a card; mixed widths use the widest', () => {
  const narrow = stairsLayout(cards(4, 288), 300, 2000, 36);
  const xs = [...narrow.values()].map((p) => p.x);
  assert.deepEqual(xs, [30, 30, 30, 30]);
  const mixed = stairsLayout([{ id: 'a', width: 224 }, { id: 'b', width: 320 }, { id: 'c', width: 288 }], 1000, 2000, 36);
  const last = mixed.get('c')!;
  assert.equal(last.x + 320, 1000 - 30, 'the stair is sized so the widest card would end at the margin');
  assert.equal(stairsLayout([], 100, 100).size, 0);
});
