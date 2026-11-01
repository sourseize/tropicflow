import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InputLog,
  ScriptPlayer,
  emptyScript,
  parseInputScript,
  scriptDuration,
  shiftScript,
  validateInputEvent,
} from '../../src/core/input/InputLog.ts';
import { InputBus } from '../../src/core/input/InputBus.ts';
import { AudioClock } from '../../src/core/audio/AudioClock.ts';
import type { InputEvent } from '../../src/core/input/InputEvents.ts';

const on = (time: number, note: number): InputEvent => ({ kind: 'noteOn', time, device: 'keys', note, velocity: 0.8 });
const off = (time: number, note: number): InputEvent => ({ kind: 'noteOff', time, device: 'keys', note });

test('InputLog records only while armed and exports times relative to the origin, sorted', () => {
  const log = new InputLog();
  log.record(on(1, 60));
  assert.equal(log.length(), 0, 'not recording yet');
  log.start(10);
  log.record(on(10.5, 60));
  log.record(off(11.25, 60));
  log.record({ kind: 'control', time: 10.75, device: 'keys', control: 'mod', value: 0.3 });
  log.stop();
  log.record(on(12, 62));
  assert.equal(log.isRecording(), false);
  const script = log.toScript();
  assert.equal(script.version, 1);
  assert.deepEqual(script.events.map((e) => [e.kind, e.time]), [['noteOn', 0.5], ['control', 0.75], ['noteOff', 1.25]]);
  assert.equal(scriptDuration(script), 1.25);
  // JSON round-trip through the validator.
  const back = parseInputScript(JSON.parse(JSON.stringify(script)));
  assert.deepEqual(back, script);
  assert.equal(log.getOrigin(), 10, 'the origin survives stop() so the script stays anchored to the transport start');
  log.start(20);
  assert.equal(log.length(), 0, 'start clears');
  log.clear();
  assert.equal(log.getOrigin(), null);
});

test('parseInputScript accepts a bare array, rejects bad versions and malformed events with a reason', () => {
  const arr = parseInputScript([on(0.2, 60), on(0.1, 62)]);
  assert.deepEqual(arr.events.map((e) => e.time), [0.1, 0.2]);
  assert.throws(() => parseInputScript({ version: 2, events: [] }), /unsupported version 2/);
  assert.throws(() => parseInputScript({}), /expected/);
  assert.throws(() => parseInputScript('nope'), /expected/);
  assert.throws(() => parseInputScript([{ kind: 'noteOn', time: -1, device: 'k', note: 60, velocity: 1 }]), /event 0: time/);
  assert.throws(() => parseInputScript([on(0, 60), { kind: 'noteOn', time: 0, device: 'k', note: 128, velocity: 1 }]), /event 1: note/);
  assert.throws(() => parseInputScript([{ kind: 'noteOn', time: 0, device: '', note: 60, velocity: 1 }]), /device/);
  assert.throws(() => parseInputScript([{ kind: 'noteOn', time: 0, device: 'k', note: 60, velocity: 2 }]), /velocity/);
  assert.throws(() => parseInputScript([{ kind: 'noteOn', time: 0, device: 'k', channel: 17, note: 60, velocity: 1 }]), /channel/);
  assert.throws(() => parseInputScript([{ kind: 'control', time: 0, device: 'k', control: 'mod', value: -0.5 }]), /value must be 0..1/);
  assert.throws(() => parseInputScript([{ kind: 'control', time: 0, device: 'k', control: 'wobble', value: 0.5 }]), /control/);
  assert.throws(() => parseInputScript([{ kind: 'pitch', time: 0, device: 'k', hz: 0, clarity: 1 }]), /hz/);
  assert.throws(() => parseInputScript([{ kind: 'level', time: 0, device: 'k', rms: 'loud' }]), /rms/);
  assert.throws(() => parseInputScript([{ kind: 'onset', time: 0, device: 'k', strength: 1.5 }]), /strength/);
  assert.throws(() => parseInputScript([{ kind: 'tap', time: 0, device: 'k' }]), /unknown kind "tap"/);
  assert.throws(() => parseInputScript([null]), /not an object/);
});

test('validateInputEvent strips unknown fields and keeps optional ones', () => {
  const e = validateInputEvent({ kind: 'noteOff', time: 1, device: 'k', note: 60, velocity: 0.5, extra: 'x' });
  assert.deepEqual(e, { kind: 'noteOff', time: 1, device: 'k', note: 60, velocity: 0.5 });
  const bend = validateInputEvent({ kind: 'control', time: 0, device: 'k', channel: 2, control: 'bend', value: -1 });
  assert.deepEqual(bend, { kind: 'control', time: 0, device: 'k', channel: 2, control: 'bend', value: -1 });
  const cc = validateInputEvent({ kind: 'control', time: 0, device: 'k', control: 74, value: 1 });
  assert.equal((cc as { control: number }).control, 74);
});

test('shiftScript moves events and clamps at zero', () => {
  const s = shiftScript({ version: 1, events: [on(0.5, 60), off(1, 60)] }, -0.75);
  assert.deepEqual(s.events.map((e) => e.time), [0, 0.25]);
  assert.equal(scriptDuration(emptyScript()), 0);
});

test('ScriptPlayer releases each event once, in order, at absolute times', () => {
  const script = { version: 1 as const, events: [on(0, 60), off(0.5, 60), on(0.5, 62), off(1, 62)] };
  const player = new ScriptPlayer(script, 10);
  assert.deepEqual(player.runTo(9.9), []);
  assert.deepEqual(player.runTo(10).map((e) => [e.kind, e.time]), [['noteOn', 10]]);
  assert.deepEqual(player.runTo(10.5).map((e) => [e.kind, e.time]), [['noteOff', 10.5], ['noteOn', 10.5]]);
  assert.equal(player.isDone(), false);
  assert.equal(player.remaining(), 1);
  assert.deepEqual(player.runTo(100).map((e) => e.time), [11]);
  assert.equal(player.isDone(), true);
  assert.deepEqual(player.runTo(200), []);
  // The source script is not mutated.
  assert.equal(script.events[0].time, 0);
});

test('ScriptPlayer driven by the clock horizon (realtime style) equals one offline pass', () => {
  const script = { version: 1 as const, events: [on(0.1, 60), off(0.3, 60), on(0.31, 62), off(0.9, 62)] };
  const offline = new ScriptPlayer(script, 2).runTo(5);
  const stepped = new ScriptPlayer(script, 2);
  const out: InputEvent[] = [];
  const clock = new AudioClock({ getTime: () => 0, bpm: 120 });
  clock.subscribeHorizon((h) => out.push(...stepped.runTo(h)));
  for (let h = 2; h <= 5; h += 0.025) clock.notifyHorizon(h);
  assert.deepEqual(out, offline);
});

test('InputBus fans out to general and per-kind listeners; a throwing listener does not block others', () => {
  const bus = new InputBus();
  const seen: string[] = [];
  const unsubAll = bus.subscribe((e) => seen.push(`all:${e.kind}`));
  bus.subscribeKind('noteOn', (e) => seen.push(`on:${(e as { note: number }).note}`));
  bus.subscribe(() => {
    throw new Error('boom');
  });
  const errors: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => errors.push(String(args[0]));
  try {
    bus.publishAll([on(0, 60), off(1, 60)]);
  } finally {
    console.error = orig;
  }
  assert.deepEqual(seen, ['all:noteOn', 'on:60', 'all:noteOff']);
  assert.equal(errors.length, 2);
  assert.equal(bus.listenerCount(), 3);
  unsubAll();
  assert.equal(bus.listenerCount(), 2);
});
