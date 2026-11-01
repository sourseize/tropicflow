import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_CABLES, INITIAL_NODES } from '../../src/core/graph/NodeGraph.ts';
import { canConnect, findPort, makeCable, resolvePatch } from '../../src/core/graph/PatchRouter.ts';

test('initial patch resolves to the documented routing', () => {
  const r = resolvePatch(INITIAL_CABLES, INITIAL_NODES);
  assert.equal(r.invalid.length, 0);
  const audio = r.audio.map((l) => `${l.fromPortId}->${l.toPortId}`).sort();
  assert.deepEqual(audio, [
    'del-wet-out->mst-in-l',
    'mrm-audio-out->del-audio-in',
    'mrm-audio-out->mst-in-l',
    'perc-audio-out->mst-in-l',
    'syn-audio-out->del-audio-in',
    'syn-audio-out->mst-in-l',
  ]);
  const trig = r.trigger.map((l) => `${l.fromPortId}->${l.toPortId}`).sort();
  assert.deepEqual(trig, [
    'chm-trig-out->mrm-trig-in',
    'chm-trig-out->perc-trig-in',
    'chm-trig-out->syn-gate-in',
    'clk-trig-1->mrm-trig-in',
    'clk-trig-1->perc-trig-in',
    'clk-trig-1->syn-gate-in',
    'midi-gate-out->mrm-trig-in', // keys / MIDI play the marimba out of the box
  ]);
});

test('only out->in of the same family can connect', () => {
  const trigOut = findPort(INITIAL_NODES, 'clk-trig-1')!.port;
  const trigIn = findPort(INITIAL_NODES, 'perc-trig-in')!.port;
  const audioIn = findPort(INITIAL_NODES, 'mst-in-l')!.port;
  const audioOut = findPort(INITIAL_NODES, 'syn-audio-out')!.port;
  assert.equal(canConnect(trigOut, trigIn), true);
  assert.equal(canConnect(trigOut, audioIn), false);
  assert.equal(canConnect(audioOut, audioIn), true);
  assert.equal(canConnect(audioIn, audioOut), false);
  assert.equal(canConnect(audioOut, audioOut), false);
});

test('makeCable normalises direction and rejects illegal pairs', () => {
  const a = makeCable(INITIAL_NODES, 'mst-in-l', 'syn-audio-out', 'c1', '#fff');
  assert.ok(a);
  assert.equal(a!.fromPortId, 'syn-audio-out');
  assert.equal(a!.toPortId, 'mst-in-l');
  assert.equal(a!.fromNodeId, 'synth-1');
  assert.equal(makeCable(INITIAL_NODES, 'clk-trig-1', 'mst-in-l', 'c2', '#fff'), null);
  assert.equal(makeCable(INITIAL_NODES, 'nope', 'mst-in-l', 'c3', '#fff'), null);
});

test('invalid and duplicate cables are filtered', () => {
  const cables = [
    INITIAL_CABLES[0],
    { ...INITIAL_CABLES[0], id: 'dup' },
    { id: 'bad', fromNodeId: 'x', fromPortId: 'mst-in-l', toNodeId: 'y', toPortId: 'syn-audio-out', color: '#000' },
  ];
  const r = resolvePatch(cables, INITIAL_NODES);
  assert.equal(r.trigger.length, 1);
  assert.equal(r.invalid.length, 1);
  assert.equal(r.invalid[0].id, 'bad');
});
