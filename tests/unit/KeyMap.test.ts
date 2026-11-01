import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE_NOTE,
  INITIAL_KEYBOARD_STATE,
  KEY_LAYOUT,
  OCTAVE_MAX,
  OCTAVE_MIN,
  codeFromKey,
  keyAction,
  reduceKey,
  releaseAll,
  type KeyInput,
  type KeyboardState,
} from '../../src/core/input/keyboard/KeyMap.ts';
import { midiNoteToHz } from '../../src/core/input/InputEvents.ts';
import type { InputEvent } from '../../src/core/input/InputEvents.ts';

const down = (code: string, extra: Partial<KeyInput> = {}): KeyInput => ({ type: 'down', code, ...extra });
const up = (code: string): KeyInput => ({ type: 'up', code });

/** Run a sequence through the reducer, collecting events. */
function run(inputs: Array<[KeyInput, number]>, start: KeyboardState = INITIAL_KEYBOARD_STATE): { state: KeyboardState; events: InputEvent[] } {
  let state = start;
  const events: InputEvent[] = [];
  for (const [input, time] of inputs) {
    const r = reduceKey(state, input, time);
    state = r.state;
    events.push(...r.events);
  }
  return { state, events };
}

test('layout: chromatic from A = C3, black keys on the row above, offsets unique and ascending', () => {
  assert.equal(KEY_LAYOUT[0].code, 'KeyA');
  assert.ok(Math.abs(midiNoteToHz(BASE_NOTE) - 130.81) < 0.01, 'A plays C3 like the soundboard always did');
  const offsets = KEY_LAYOUT.map((k) => k.offset);
  assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
  assert.equal(new Set(offsets).size, offsets.length);
  for (const k of KEY_LAYOUT) assert.equal(k.black, [1, 3, 6, 8, 10].includes(k.offset % 12), k.code);
  assert.deepEqual(keyAction('KeyK'), { type: 'note', offset: 12 });
  assert.deepEqual(keyAction('KeyZ'), { type: 'octave', delta: -1 });
  assert.deepEqual(keyAction('Space'), { type: 'tap' });
  assert.equal(keyAction('Enter'), null);
});

test('codeFromKey fallback covers letters, ; and \' and arrows', () => {
  assert.equal(codeFromKey('a'), 'KeyA');
  assert.equal(codeFromKey('A'), 'KeyA');
  assert.equal(codeFromKey(';'), 'Semicolon');
  assert.equal(codeFromKey("'"), 'Quote');
  assert.equal(codeFromKey('ArrowUp'), 'ArrowUp');
  assert.equal(codeFromKey('Shift'), null);
  assert.equal(codeFromKey('1'), null);
  // reduceKey uses it when code is missing.
  const r = reduceKey(INITIAL_KEYBOARD_STATE, { type: 'down', code: '', key: 'h' }, 1);
  assert.deepEqual(r.events, [{ kind: 'noteOn', time: 1, device: 'keys', note: 57, velocity: 0.8 }]);
});

test('key down/up = note on/off with the state velocity; repeats and double presses are ignored', () => {
  const { state, events } = run([
    [down('KeyA'), 1],
    [down('KeyA', { repeat: true }), 1.1],
    [down('KeyA'), 1.2],
    [up('KeyA'), 2],
    [up('KeyA'), 2.1],
    [up('KeyS'), 2.2],
  ]);
  assert.deepEqual(events, [
    { kind: 'noteOn', time: 1, device: 'keys', note: 48, velocity: 0.8 },
    { kind: 'noteOff', time: 2, device: 'keys', note: 48 },
  ]);
  assert.deepEqual(state.held, {});
  // No-ops return the very same state object (cheap for React state).
  const s = reduceKey(INITIAL_KEYBOARD_STATE, down('Enter'), 0);
  assert.equal(s.state, INITIAL_KEYBOARD_STATE);
  // Space taps (an onset from the keys) without touching the state.
  const tap = reduceKey(INITIAL_KEYBOARD_STATE, down('Space', { shiftKey: true }), 3);
  assert.equal(tap.state, INITIAL_KEYBOARD_STATE);
  assert.deepEqual(tap.events, [{ kind: 'onset', time: 3, device: 'keys', strength: 0.95 }]);
  assert.deepEqual(reduceKey(INITIAL_KEYBOARD_STATE, up('Space'), 3).events, []);
});

test('octave keys shift new notes but held notes release with the note they started on', () => {
  const { state, events } = run([
    [down('KeyA'), 0],
    [down('KeyX'), 0.1],
    [down('KeyS'), 0.2],
    [up('KeyA'), 0.3],
    [down('KeyZ'), 0.4],
    [down('KeyZ'), 0.5],
    [down('KeyZ'), 0.6],
    [down('KeyZ'), 0.7], // clamped at OCTAVE_MIN
    [down('KeyD'), 0.8],
    [up('KeyS'), 0.9],
  ]);
  assert.deepEqual(
    events.map((e) => `${e.kind}:${(e as { note: number }).note}`),
    ['noteOn:48', 'noteOn:62', 'noteOff:48', 'noteOn:28', 'noteOff:62']
  );
  assert.equal(state.octave, OCTAVE_MIN);
  let s = INITIAL_KEYBOARD_STATE;
  for (let i = 0; i < 10; i++) s = reduceKey(s, down('KeyX'), 0).state;
  assert.equal(s.octave, OCTAVE_MAX);
  // Key up on octave keys does nothing.
  assert.equal(reduceKey(s, up('KeyX'), 0).state, s);
});

test('velocity keys step by 0.1 within 0.1..1; Shift accents a note', () => {
  const { state } = run([[down('KeyV'), 0], [down('KeyV'), 0], [down('KeyV'), 0]]);
  assert.equal(state.velocity, 1);
  let s = INITIAL_KEYBOARD_STATE;
  for (let i = 0; i < 12; i++) s = reduceKey(s, down('KeyC'), 0).state;
  assert.ok(Math.abs(s.velocity - 0.1) < 1e-12);
  const accent = reduceKey({ ...INITIAL_KEYBOARD_STATE, velocity: 0.9 }, down('KeyA', { shiftKey: true }), 0);
  assert.equal((accent.events[0] as { velocity: number }).velocity, 1, 'accent is clamped to 1');
  const soft = reduceKey({ ...INITIAL_KEYBOARD_STATE, velocity: 0.5 }, down('KeyA', { shiftKey: true }), 0);
  assert.ok(Math.abs((soft.events[0] as { velocity: number }).velocity - 0.75) < 1e-12);
});

test('arrow keys: mod wheel steps and publishes control events, bend springs back on release', () => {
  const { state, events } = run([
    [down('ArrowUp'), 0],
    [down('ArrowUp'), 0.1],
    [down('ArrowDown'), 0.2],
    [down('ArrowRight'), 0.3],
    [down('ArrowRight', { repeat: true }), 0.35],
    [up('ArrowRight'), 0.4],
    [down('ArrowLeft'), 0.5],
    [up('ArrowLeft'), 0.6],
    [up('ArrowLeft'), 0.7], // already at rest: no event
  ]);
  assert.deepEqual(
    events.map((e) => [e.time, (e as { control: string }).control, (e as { value: number }).value]),
    [
      [0, 'mod', 0.1],
      [0.1, 'mod', 0.2],
      [0.2, 'mod', 0.1],
      [0.3, 'bend', 1],
      [0.4, 'bend', 0],
      [0.5, 'bend', -1],
      [0.6, 'bend', 0],
    ]
  );
  assert.equal(state.mod, 0.1);
  assert.equal(state.bend, 0);
  // Mod wheel clamps at 0 and 1 without emitting duplicates.
  const atZero = reduceKey(INITIAL_KEYBOARD_STATE, down('ArrowDown'), 0);
  assert.deepEqual(atZero.events, []);
});

test('releaseAll emits note-offs for every held key and resets the bend', () => {
  const { state } = run([[down('KeyA'), 0], [down('KeyK'), 0], [down('ArrowRight'), 0]]);
  const r = releaseAll(state, 3);
  assert.deepEqual(
    r.events.map((e) => `${e.kind}:${(e as { note?: number; control?: string }).note ?? (e as { control: string }).control}`).sort(),
    ['control:bend', 'noteOff:48', 'noteOff:60']
  );
  assert.deepEqual(r.state.held, {});
  assert.equal(r.state.bend, 0);
  assert.equal(releaseAll(r.state, 4).state, r.state, 'nothing to release: same state');
});
