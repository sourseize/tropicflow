/**
 * The computer keyboard as a MIDI-like device: a pure reducer from key
 * down/up to InputEvents, with octave, velocity, mod wheel and pitch bend
 * keys. No DOM here; KeyboardDevice (UI layer) feeds it KeyboardEvents and
 * tests feed it plain objects.
 *
 * Layout (physical `KeyboardEvent.code`, so it works on AZERTY/QWERTZ too):
 *
 *    W E   T Y U   O P        black keys
 *   A S D F G H J K L ; '     white keys, A = C (octave 0 -> C3)
 *
 *   Z / X   octave down / up        C / V   velocity down / up
 *   Up / Down  mod wheel            Left / Right  pitch bend (springs back)
 *   Shift + note                    accent (+0.25 velocity)
 *   Space                           tap (a clap for the SENSE module's virtual voice)
 */
import { KEYS_DEVICE, type InputEvent, clamp01 } from '../InputEvents.ts';

export interface KeyLayoutEntry {
  code: string;
  /** Printed key cap for the UI. */
  label: string;
  /** Semitones above the base note of the current octave. */
  offset: number;
  black: boolean;
}

export const KEY_LAYOUT: readonly KeyLayoutEntry[] = [
  { code: 'KeyA', label: 'A', offset: 0, black: false },
  { code: 'KeyW', label: 'W', offset: 1, black: true },
  { code: 'KeyS', label: 'S', offset: 2, black: false },
  { code: 'KeyE', label: 'E', offset: 3, black: true },
  { code: 'KeyD', label: 'D', offset: 4, black: false },
  { code: 'KeyF', label: 'F', offset: 5, black: false },
  { code: 'KeyT', label: 'T', offset: 6, black: true },
  { code: 'KeyG', label: 'G', offset: 7, black: false },
  { code: 'KeyY', label: 'Y', offset: 8, black: true },
  { code: 'KeyH', label: 'H', offset: 9, black: false },
  { code: 'KeyU', label: 'U', offset: 10, black: true },
  { code: 'KeyJ', label: 'J', offset: 11, black: false },
  { code: 'KeyK', label: 'K', offset: 12, black: false },
  { code: 'KeyO', label: 'O', offset: 13, black: true },
  { code: 'KeyL', label: 'L', offset: 14, black: false },
  { code: 'KeyP', label: 'P', offset: 15, black: true },
  { code: 'Semicolon', label: ';', offset: 16, black: false },
  { code: 'Quote', label: "'", offset: 17, black: false },
];

/** MIDI note of offset 0 at octave 0 (C3, 130.81 Hz - the range the synth presets use). */
export const BASE_NOTE = 48;
export const OCTAVE_MIN = -2;
export const OCTAVE_MAX = 3;
export const VELOCITY_STEP = 0.1;
export const MOD_STEP = 0.1;
export const ACCENT_BOOST = 0.25;

export type KeyAction =
  | { type: 'note'; offset: number }
  | { type: 'octave'; delta: 1 | -1 }
  | { type: 'velocity'; delta: 1 | -1 }
  | { type: 'mod'; delta: 1 | -1 }
  | { type: 'bend'; direction: 1 | -1 }
  | { type: 'tap' };

const NOTE_BY_CODE = new Map(KEY_LAYOUT.map((k) => [k.code, k.offset]));

const CONTROL_BY_CODE: Record<string, KeyAction> = {
  KeyZ: { type: 'octave', delta: -1 },
  KeyX: { type: 'octave', delta: 1 },
  KeyC: { type: 'velocity', delta: -1 },
  KeyV: { type: 'velocity', delta: 1 },
  ArrowUp: { type: 'mod', delta: 1 },
  ArrowDown: { type: 'mod', delta: -1 },
  ArrowLeft: { type: 'bend', direction: -1 },
  ArrowRight: { type: 'bend', direction: 1 },
  Space: { type: 'tap' },
};

/** Strength of a keyboard tap (Shift = harder). */
export const TAP_STRENGTH = 0.7;

/** Fallback for environments that give `key` but no `code` (some virtual keyboards). */
export function codeFromKey(key: string): string | null {
  if (key.length === 1) {
    const c = key.toLowerCase();
    if (c >= 'a' && c <= 'z') return `Key${c.toUpperCase()}`;
    if (c === ';') return 'Semicolon';
    if (c === "'") return 'Quote';
    return null;
  }
  if (key.startsWith('Arrow')) return key;
  if (key === ' ') return 'Space';
  return null;
}

export function keyAction(code: string): KeyAction | null {
  const offset = NOTE_BY_CODE.get(code);
  if (offset !== undefined) return { type: 'note', offset };
  return CONTROL_BY_CODE[code] ?? null;
}

export interface KeyboardState {
  octave: number;
  /** Velocity 0.1..1 used for the next note-on. */
  velocity: number;
  mod: number;
  bend: number;
  /** Held note keys: code -> MIDI note (fixed at press time, so octave changes do not orphan them). */
  held: Record<string, number>;
}

export const INITIAL_KEYBOARD_STATE: KeyboardState = {
  octave: 0,
  velocity: 0.8,
  mod: 0,
  bend: 0,
  held: {},
};

/** What the reducer consumes: the subset of KeyboardEvent it needs. */
export interface KeyInput {
  type: 'down' | 'up';
  code: string;
  key?: string;
  shiftKey?: boolean;
  repeat?: boolean;
}

export interface KeyReduction {
  state: KeyboardState;
  events: InputEvent[];
}

/** MIDI note for a layout offset at the state's octave. */
export function noteForOffset(state: KeyboardState, offset: number): number {
  return BASE_NOTE + state.octave * 12 + offset;
}

/**
 * Apply one key event. Pure: returns the next state and the InputEvents to
 * publish (times = `time`). Auto-repeat, unknown keys and double presses are
 * no-ops that return the same state object.
 */
export function reduceKey(state: KeyboardState, input: KeyInput, time: number, device: string = KEYS_DEVICE): KeyReduction {
  if (input.repeat) return { state, events: [] };
  const code = input.code || (input.key ? codeFromKey(input.key) : null);
  if (!code) return { state, events: [] };
  const action = keyAction(code);
  if (!action) return { state, events: [] };

  if (action.type === 'note') {
    if (input.type === 'down') {
      if (code in state.held) return { state, events: [] };
      const note = noteForOffset(state, action.offset);
      const velocity = clamp01(state.velocity + (input.shiftKey ? ACCENT_BOOST : 0));
      return {
        state: { ...state, held: { ...state.held, [code]: note } },
        events: [{ kind: 'noteOn', time, device, note, velocity }],
      };
    }
    const note = state.held[code];
    if (note === undefined) return { state, events: [] };
    const held = { ...state.held };
    delete held[code];
    return { state: { ...state, held }, events: [{ kind: 'noteOff', time, device, note }] };
  }

  if (action.type === 'bend') {
    const value = input.type === 'down' ? action.direction : 0;
    if (value === state.bend) return { state, events: [] };
    return { state: { ...state, bend: value }, events: [{ kind: 'control', time, device, control: 'bend', value }] };
  }

  if (input.type !== 'down') return { state, events: [] };

  if (action.type === 'tap') {
    return { state, events: [{ kind: 'onset', time, device, strength: clamp01(TAP_STRENGTH + (input.shiftKey ? ACCENT_BOOST : 0)) }] };
  }
  if (action.type === 'octave') {
    const octave = Math.max(OCTAVE_MIN, Math.min(OCTAVE_MAX, state.octave + action.delta));
    return { state: octave === state.octave ? state : { ...state, octave }, events: [] };
  }
  if (action.type === 'velocity') {
    const velocity = Math.max(VELOCITY_STEP, Math.min(1, round1(state.velocity + action.delta * VELOCITY_STEP)));
    return { state: velocity === state.velocity ? state : { ...state, velocity }, events: [] };
  }
  // mod wheel
  const mod = clamp01(round1(state.mod + action.delta * MOD_STEP));
  if (mod === state.mod) return { state, events: [] };
  return { state: { ...state, mod }, events: [{ kind: 'control', time, device, control: 'mod', value: mod }] };
}

/** Release everything (window blur, module disabled): note-offs for all held keys, bend to rest. */
export function releaseAll(state: KeyboardState, time: number, device: string = KEYS_DEVICE): KeyReduction {
  const events: InputEvent[] = Object.values(state.held).map((note) => ({ kind: 'noteOff', time, device, note }));
  if (state.bend !== 0) events.push({ kind: 'control', time, device, control: 'bend', value: 0 });
  if (events.length === 0) return { state, events };
  return { state: { ...state, held: {}, bend: 0 }, events };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
