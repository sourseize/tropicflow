/**
 * The one event stream every input device feeds: a physical MIDI keyboard,
 * the computer keyboard, the microphone tracker, or a replayed script.
 *
 * `time` is always audio-context seconds, the only clock the engine schedules
 * against. Device adapters convert their own timestamps before publishing
 * (see TimestampMapper). Everything here is pure and serialisable so a
 * performance can be logged, saved and replayed offline.
 */

/** Device identifiers: `kind:id`, e.g. `midi:input-0`, `keys`, `sensor:mic`, `script`. */
export type DeviceKind = 'midi' | 'keys' | 'sensor' | 'script';

export const KEYS_DEVICE = 'keys';
export const SCRIPT_DEVICE = 'script';
export const SENSOR_MIC_DEVICE = 'sensor:mic';
export const SENSOR_VOICE_DEVICE = 'sensor:voice';

export function midiDeviceId(id: string): string {
  return `midi:${id}`;
}

export function deviceKind(device: string): DeviceKind {
  const head = device.split(':')[0];
  if (head === 'midi' || head === 'keys' || head === 'sensor' || head === 'script') return head;
  return 'script';
}

/** Named continuous controllers; anything else is its raw CC number. */
export type ControlName = 'mod' | 'bend' | 'aftertouch' | 'sustain' | 'volume' | 'expression';
export type ControlId = ControlName | number;

interface InputEventBase {
  /** Audio-context time (seconds). */
  time: number;
  device: string;
  /** MIDI channel 1-16 when the device has one. */
  channel?: number;
}

export interface NoteOnEvent extends InputEventBase {
  kind: 'noteOn';
  /** MIDI note number (60 = C4 = 261.63 Hz). */
  note: number;
  /** 0..1 */
  velocity: number;
}

export interface NoteOffEvent extends InputEventBase {
  kind: 'noteOff';
  note: number;
  /** Release velocity 0..1 when the device sends one. */
  velocity?: number;
}

export interface ControlEvent extends InputEventBase {
  kind: 'control';
  control: ControlId;
  /** 0..1, except `bend`: -1..1 with 0 at rest. */
  value: number;
}

/** Tracked pitch from the sensor (microphone / virtual voice). */
export interface PitchEvent extends InputEventBase {
  kind: 'pitch';
  hz: number;
  /** 0..1 confidence; consumers gate on it. */
  clarity: number;
}

/** Tracked level from the sensor. */
export interface LevelEvent extends InputEventBase {
  kind: 'level';
  /** Linear RMS 0..1. */
  rms: number;
}

/** Transient detected by the sensor (a clap, a drum hit). */
export interface OnsetEvent extends InputEventBase {
  kind: 'onset';
  /** 0..1 */
  strength: number;
}

export type InputEvent = NoteOnEvent | NoteOffEvent | ControlEvent | PitchEvent | LevelEvent | OnsetEvent;
export type InputEventKind = InputEvent['kind'];

export const INPUT_EVENT_KINDS: readonly InputEventKind[] = ['noteOn', 'noteOff', 'control', 'pitch', 'level', 'onset'];

// ---------------------------------------------------------------------------
// Note / frequency helpers
// ---------------------------------------------------------------------------

export const A4_HZ = 440;
export const A4_NOTE = 69;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** Equal temperament; fractional notes are allowed (e.g. 60.5 = a quarter tone above C4). */
export function midiNoteToHz(note: number, a4Hz: number = A4_HZ): number {
  return a4Hz * Math.pow(2, (note - A4_NOTE) / 12);
}

/** Inverse of midiNoteToHz; fractional (not rounded) so cents can be derived. */
export function hzToMidiNote(hz: number, a4Hz: number = A4_HZ): number {
  return A4_NOTE + 12 * Math.log2(hz / a4Hz);
}

/** Scientific pitch name of a (rounded) MIDI note: 60 -> "C4", 61 -> "C#4". */
export function noteName(note: number): string {
  const n = Math.round(note);
  const octave = Math.floor(n / 12) - 1;
  const idx = ((n % 12) + 12) % 12;
  return `${NOTE_NAMES[idx]}${octave}`;
}

/** Parse "C4", "F#3", "Bb2" (flats accepted) back to a MIDI note number; null when malformed. */
export function parseNoteName(name: string): number | null {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(name.trim());
  if (!m) return null;
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase() as 'c' | 'd' | 'e' | 'f' | 'g' | 'a' | 'b'];
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return (Number(m[3]) + 1) * 12 + base + acc;
}

/** Nearest note and the deviation in cents (-50..50), e.g. for a tuner display. */
export function nearestNote(hz: number, a4Hz: number = A4_HZ): { note: number; name: string; cents: number; hz: number } {
  const exact = hzToMidiNote(hz, a4Hz);
  const note = Math.round(exact);
  return { note, name: noteName(note), cents: (exact - note) * 100, hz: midiNoteToHz(note, a4Hz) };
}

/** Clamp a velocity / control value into 0..1. */
export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Stable ordering for event lists: by time, then note-offs before note-ons at equal time. */
export function compareInputEvents(a: InputEvent, b: InputEvent): number {
  if (a.time !== b.time) return a.time - b.time;
  const rank = (e: InputEvent) => (e.kind === 'noteOff' ? 0 : e.kind === 'noteOn' ? 2 : 1);
  return rank(a) - rank(b);
}
