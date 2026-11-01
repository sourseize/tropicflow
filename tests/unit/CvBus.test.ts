import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CvBus, scaleCv } from '../../src/core/cv/CvBus.ts';
import { resolvePatch } from '../../src/core/graph/PatchRouter.ts';
import { INITIAL_CABLES, INITIAL_NODES } from '../../src/core/graph/NodeGraph.ts';
import { AudioClock } from '../../src/core/audio/AudioClock.ts';
import type { PatchCable } from '../../src/core/graph/GraphTypes.ts';

const cable = (from: string, to: string, id = `${from}->${to}`): PatchCable => ({ id, fromNodeId: '', fromPortId: from, toNodeId: '', toPortId: to, color: '#fff' });
const cv = (cables: PatchCable[]) => resolvePatch(cables, INITIAL_NODES).cv;

test('scaling: pitch sources pass semitones, control sources span an octave / 3 octaves of cutoff / double delay', () => {
  assert.equal(scaleCv('pitch', 'pitch', -2), -2);
  assert.equal(scaleCv('pitch', 'cutoff', 12), 1);
  assert.equal(scaleCv('control', 'pitch', 0.5), 6);
  assert.equal(scaleCv('control', 'cutoff', 1), 3);
  assert.equal(scaleCv('control', 'time', 1), 1);
});

test('the default patch routes mod wheel -> cutoff and bend -> synth pitch; nothing else', () => {
  const bus = new CvBus();
  const initial = bus.setLinks(cv(INITIAL_CABLES));
  assert.deepEqual(initial, [], 'no target changes while every source is at rest');
  assert.deepEqual(bus.sourcesOf('syn-filter-cv'), ['midi-mod-cv']);
  assert.deepEqual(bus.sourcesOf('syn-pitch-cv'), ['midi-pitch-cv']);
  assert.deepEqual(bus.sourcesOf('mrm-cv-in'), []);
  assert.deepEqual(bus.setSource('midi-mod-cv', 0.5), [{ targetPortId: 'syn-filter-cv', kind: 'cutoff', value: 1.5 }]);
  assert.deepEqual(bus.setSource('midi-mod-cv', 0.5), [], 'same value: no change');
  assert.deepEqual(bus.setSource('midi-pitch-cv', -2), [{ targetPortId: 'syn-pitch-cv', kind: 'pitch', value: -2 }]);
  assert.equal(bus.targetValue('mrm-cv-in'), 0, 'unpatched target stays at 0');
  assert.deepEqual(bus.setSource('no-such-jack', 1), []);
});

test('several sources into one target add up; re-patching recomputes and reports what changed', () => {
  const bus = new CvBus();
  bus.setSource('midi-mod-cv', 1);
  bus.setSource('midi-pitch-cv', 3);
  const changes = bus.setLinks(cv([cable('midi-mod-cv', 'mrm-cv-in'), cable('midi-pitch-cv', 'mrm-cv-in')]));
  assert.deepEqual(changes, [{ targetPortId: 'mrm-cv-in', kind: 'pitch', value: 15 }]);
  // Unplug the mod cable: the target drops to the bend alone.
  assert.deepEqual(bus.setLinks(cv([cable('midi-pitch-cv', 'mrm-cv-in')])), [{ targetPortId: 'mrm-cv-in', kind: 'pitch', value: 3 }]);
  // Unplug everything: back to 0.
  assert.deepEqual(bus.setLinks([]), [{ targetPortId: 'mrm-cv-in', kind: 'pitch', value: 0 }]);
  // Illegal cables never reach the bus (PatchRouter rejects trigger -> cv).
  assert.deepEqual(bus.setLinks(cv([cable('clk-trig-1', 'syn-filter-cv')])), []);
});

test('SWING CV: the clock reports swing changes (engine publishes them as a 0..1 control)', () => {
  const clock = new AudioClock({ getTime: () => 0 });
  const seen: number[] = [];
  const unsub = clock.subscribeSwing((s) => seen.push(s));
  clock.setSwing(0.25);
  clock.setSwing(0.25);
  clock.setSwing(0.9); // clamped to 0.5
  unsub();
  clock.setSwing(0);
  assert.deepEqual(seen, [0.25, 0.5]);
  const bus = new CvBus();
  bus.setLinks(cv([cable('clk-swing-1', 'del-time-cv')]));
  assert.deepEqual(bus.setSource('clk-swing-1', 0.5 / 0.5), [{ targetPortId: 'del-time-cv', kind: 'time', value: 1 }]);
});
