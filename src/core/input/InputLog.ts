/**
 * Record, serialise and replay input performances.
 *
 *  - InputLog:        records live events (absolute audio time) while armed.
 *  - InputScript:     the serialised form, times relative to the script start,
 *                     so it can be replayed at any transport position or in an
 *                     offline render (RenderConfig.inputScript).
 *  - parseInputScript: validates untrusted JSON (user files).
 *  - ScriptPlayer:    releases a script's events up to a horizon, exactly like
 *                     ChamberEngine.runTo(), for both realtime and offline use.
 */
import { type ControlId, INPUT_EVENT_KINDS, type InputEvent, compareInputEvents } from './InputEvents.ts';

export const INPUT_SCRIPT_VERSION = 1;

export interface InputScript {
  version: typeof INPUT_SCRIPT_VERSION;
  /** Events with `time` relative to the script start, sorted. */
  events: InputEvent[];
}

export function emptyScript(): InputScript {
  return { version: INPUT_SCRIPT_VERSION, events: [] };
}

/** Time of the last event (0 for an empty script). */
export function scriptDuration(script: InputScript): number {
  let end = 0;
  for (const e of script.events) if (e.time > end) end = e.time;
  return end;
}

/** Copy of a script with every time shifted by `offset` (negative times are clamped to 0). */
export function shiftScript(script: InputScript, offset: number): InputScript {
  return {
    version: INPUT_SCRIPT_VERSION,
    events: script.events.map((e) => ({ ...e, time: Math.max(0, e.time + offset) })).sort(compareInputEvents),
  };
}

export class InputLog {
  private events: InputEvent[] = [];
  /** Audio time the script's 0 corresponds to (the transport start); kept after stop(). */
  private origin: number | null = null;
  private recording: boolean = false;

  /** Start recording; events are stored relative to `originTime` when exported. */
  public start(originTime: number): void {
    this.events = [];
    this.origin = originTime;
    this.recording = true;
  }

  public stop(): void {
    this.recording = false;
  }

  public isRecording(): boolean {
    return this.recording;
  }

  public getOrigin(): number | null {
    return this.origin;
  }

  public length(): number {
    return this.events.length;
  }

  /** Store an event (absolute time). Ignored when not recording. */
  public record(event: InputEvent): void {
    if (!this.recording) return;
    this.events.push(event);
  }

  /** The recorded performance, relative to the origin and sorted. Available after stop() too. */
  public toScript(): InputScript {
    const origin = this.origin ?? 0;
    return {
      version: INPUT_SCRIPT_VERSION,
      events: this.events.map((e) => ({ ...e, time: Math.max(0, e.time - origin) })).sort(compareInputEvents),
    };
  }

  public clear(): void {
    this.events = [];
    this.origin = null;
    this.recording = false;
  }
}

// ---------------------------------------------------------------------------
// Validation of untrusted JSON
// ---------------------------------------------------------------------------

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function fail(index: number, reason: string): never {
  throw new Error(`input script: event ${index}: ${reason}`);
}

/** Validate one event object; throws with the index and reason when malformed. */
export function validateInputEvent(raw: unknown, index: number = 0): InputEvent {
  if (typeof raw !== 'object' || raw === null) fail(index, 'not an object');
  const o = raw as Record<string, unknown>;
  const kind = o.kind as InputEvent['kind'];
  if (!INPUT_EVENT_KINDS.includes(kind)) fail(index, `unknown kind "${String(o.kind)}"`);
  if (!isFiniteNumber(o.time) || o.time < 0) fail(index, 'time must be a non-negative number');
  if (typeof o.device !== 'string' || o.device.length === 0) fail(index, 'device must be a non-empty string');
  if (o.channel !== undefined && (!Number.isInteger(o.channel) || (o.channel as number) < 1 || (o.channel as number) > 16)) {
    fail(index, 'channel must be 1..16');
  }
  const base = { time: o.time, device: o.device, ...(o.channel !== undefined ? { channel: o.channel as number } : {}) };

  switch (kind) {
    case 'noteOn': {
      if (!Number.isInteger(o.note) || (o.note as number) < 0 || (o.note as number) > 127) fail(index, 'note must be 0..127');
      if (!isFiniteNumber(o.velocity) || o.velocity < 0 || o.velocity > 1) fail(index, 'velocity must be 0..1');
      return { kind, ...base, note: o.note as number, velocity: o.velocity };
    }
    case 'noteOff': {
      if (!Number.isInteger(o.note) || (o.note as number) < 0 || (o.note as number) > 127) fail(index, 'note must be 0..127');
      if (o.velocity !== undefined && (!isFiniteNumber(o.velocity) || o.velocity < 0 || o.velocity > 1)) fail(index, 'velocity must be 0..1');
      return { kind, ...base, note: o.note as number, ...(o.velocity !== undefined ? { velocity: o.velocity as number } : {}) };
    }
    case 'control': {
      const c = o.control;
      const named = c === 'mod' || c === 'bend' || c === 'aftertouch' || c === 'sustain' || c === 'volume' || c === 'expression';
      const numbered = Number.isInteger(c) && (c as number) >= 0 && (c as number) <= 127;
      if (!named && !numbered) fail(index, 'control must be a name or a controller number 0..127');
      const lo = c === 'bend' ? -1 : 0;
      if (!isFiniteNumber(o.value) || o.value < lo || o.value > 1) fail(index, `value must be ${lo}..1`);
      return { kind, ...base, control: c as ControlId, value: o.value };
    }
    case 'pitch': {
      if (!isFiniteNumber(o.hz) || o.hz <= 0) fail(index, 'hz must be positive');
      if (!isFiniteNumber(o.clarity) || o.clarity < 0 || o.clarity > 1) fail(index, 'clarity must be 0..1');
      return { kind, ...base, hz: o.hz, clarity: o.clarity };
    }
    case 'level': {
      if (!isFiniteNumber(o.rms) || o.rms < 0) fail(index, 'rms must be >= 0');
      return { kind, ...base, rms: o.rms };
    }
    case 'onset': {
      if (!isFiniteNumber(o.strength) || o.strength < 0 || o.strength > 1) fail(index, 'strength must be 0..1');
      return { kind, ...base, strength: o.strength };
    }
  }
}

/**
 * Parse a script from JSON (an object `{ version, events }` or a bare event
 * array). Throws a descriptive Error on anything malformed; the result is
 * sorted and safe to replay.
 */
export function parseInputScript(json: unknown): InputScript {
  const events = Array.isArray(json) ? json : (json as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) throw new Error('input script: expected { version, events: [...] } or an array of events');
  const version = Array.isArray(json) ? INPUT_SCRIPT_VERSION : (json as { version?: unknown }).version;
  if (version !== undefined && version !== INPUT_SCRIPT_VERSION) {
    throw new Error(`input script: unsupported version ${String(version)} (expected ${INPUT_SCRIPT_VERSION})`);
  }
  return { version: INPUT_SCRIPT_VERSION, events: events.map((e, i) => validateInputEvent(e, i)).sort(compareInputEvents) };
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

/**
 * Releases a script's events in time order as the horizon advances. Each
 * event is returned exactly once with its absolute time (`startTime` +
 * relative time). The realtime driver calls `runTo()` from the clock's
 * horizon callback; the offline renderer calls it once with the render end.
 */
export class ScriptPlayer {
  private readonly events: InputEvent[];
  private readonly startTime: number;
  private cursor: number = 0;

  constructor(script: InputScript, startTime: number) {
    this.events = [...script.events].sort(compareInputEvents);
    this.startTime = startTime;
  }

  public getStartTime(): number {
    return this.startTime;
  }

  /** Events with absolute time <= `horizon` that have not been released yet. */
  public runTo(horizon: number): InputEvent[] {
    const out: InputEvent[] = [];
    while (this.cursor < this.events.length) {
      const e = this.events[this.cursor];
      const time = this.startTime + e.time;
      if (time > horizon) break;
      out.push({ ...e, time });
      this.cursor++;
    }
    return out;
  }

  public isDone(): boolean {
    return this.cursor >= this.events.length;
  }

  public remaining(): number {
    return this.events.length - this.cursor;
  }
}
