import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MAPPING, degreeToFrequency, mapCollision } from '../../src/core/physics/CollisionMapper.ts';
import type { CollisionEvent } from '../../src/core/physics/ChamberTypes.ts';

const ev = (partial: Partial<CollisionEvent>): CollisionEvent => ({
  time: 1,
  ballId: 1,
  surfaceKind: 'wall',
  surfaceId: 'floor',
  side: 'floor',
  impactSpeed: 1.1,
  position: { x: 0.5, y: 1 },
  normal: { x: 0, y: -1 },
  ...partial,
});

test('degreeToFrequency follows the scale and wraps octaves', () => {
  const scale = [0, 2, 4, 7, 9];
  assert.ok(Math.abs(degreeToFrequency(0, scale, 261.63) - 261.63) < 1e-9);
  assert.ok(Math.abs(degreeToFrequency(1, scale, 261.63) - 261.63 * 2 ** (2 / 12)) < 1e-9);
  assert.ok(Math.abs(degreeToFrequency(5, scale, 261.63) - 523.26) < 1e-9);
  assert.ok(Math.abs(degreeToFrequency(-1, scale, 261.63) - 261.63 * 2 ** (-3 / 12)) < 1e-9);
});

test('surfaces map to the configured instruments with velocity from impact speed', () => {
  const m = DEFAULT_MAPPING;
  assert.deepEqual(mapCollision(ev({ impactSpeed: 2.2 }), m), { track: 'kick', velocity: 1 });
  assert.deepEqual(mapCollision(ev({ impactSpeed: 1.1 }), m), { track: 'kick', velocity: 0.5 });
  assert.deepEqual(mapCollision(ev({ impactSpeed: 0.01 }), m), { track: 'kick', velocity: m.minVelocity });
  assert.deepEqual(mapCollision(ev({ side: 'ceiling', surfaceId: 'ceiling' }), m), { track: 'snare', velocity: 0.5 });
  assert.deepEqual(mapCollision(ev({ side: 'left', surfaceId: 'left' }), m), { track: 'hihat', velocity: 0.5, open: false });
  assert.deepEqual(mapCollision(ev({ side: 'right', surfaceId: 'right' }), m), { track: 'hihat', velocity: 0.5, open: true });
  const peg = mapCollision(ev({ surfaceKind: 'peg', surfaceId: 'p', side: undefined, note: 2, impactSpeed: 2.2 }), m)!;
  assert.equal(peg.track, 'marimba');
  assert.ok(Math.abs(peg.frequency! - 261.63 * 2 ** (4 / 12)) < 1e-9);
  const seg = mapCollision(ev({ surfaceKind: 'segment', surfaceId: 's', side: undefined, note: 5 }), m)!;
  assert.equal(seg.track, 'synth');
  assert.equal(seg.duration, m.synthDuration);
  assert.ok(Math.abs(seg.frequency! - 523.26) < 1e-9);
});

test("'none' silences a surface", () => {
  const m = { ...DEFAULT_MAPPING, floor: { track: 'none' as const } };
  assert.equal(mapCollision(ev({}), m), null);
});

test('UI helpers: scale names, surface choices round-trip', async () => {
  const { SCALES, scaleName, surfaceChoice, surfaceMappingFromChoice, SURFACE_CHOICES } = await import('../../src/core/physics/CollisionMapper.ts');
  assert.equal(scaleName([0, 2, 4, 7, 9]), 'major pentatonic');
  assert.equal(scaleName([0, 1]), null);
  for (const name of Object.keys(SCALES)) assert.equal(scaleName(SCALES[name]), name);
  for (const c of SURFACE_CHOICES) assert.equal(surfaceChoice(surfaceMappingFromChoice(c)), c);
  assert.deepEqual(surfaceMappingFromChoice('hihat-open'), { track: 'hihat', open: true });
});

test('a remapped floor changes the instrument of the same collision', () => {
  const remapped = { ...DEFAULT_MAPPING, floor: { track: 'marimba' as const } };
  const note = mapCollision(ev({ note: 2 }), remapped)!;
  assert.equal(note.track, 'marimba');
  assert.ok(Math.abs(note.frequency! - degreeToFrequency(2, remapped.scale, remapped.rootHz)) < 1e-9);
});
