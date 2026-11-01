/**
 * MIDI byte stream -> InputEvents. Pure; no Web MIDI types involved so it is
 * unit-tested in Node and reused for scripted / logged input.
 *
 * Two layers:
 *  - decodeMidiMessage(): one complete channel message -> typed MidiMessage
 *  - MidiParser: a byte stream with running status, system messages skipped,
 *    optional channel filter, producing InputEvents at a given time.
 */
import { type ControlId, type InputEvent, clamp01 } from '../InputEvents.ts';

export type MidiMessage =
  | { type: 'noteOn'; channel: number; note: number; velocity: number }
  | { type: 'noteOff'; channel: number; note: number; velocity: number }
  | { type: 'polyAftertouch'; channel: number; note: number; pressure: number }
  | { type: 'controlChange'; channel: number; controller: number; value: number }
  | { type: 'programChange'; channel: number; program: number }
  | { type: 'channelAftertouch'; channel: number; pressure: number }
  | { type: 'pitchBend'; channel: number; value: number };

/** Controller numbers with a name in InputEvents.ControlId. */
export const CC_MOD = 1;
export const CC_VOLUME = 7;
export const CC_EXPRESSION = 11;
export const CC_SUSTAIN = 64;
/** All Notes Off / All Sound Off (channel mode messages). */
export const CC_ALL_SOUND_OFF = 120;
export const CC_ALL_NOTES_OFF = 123;

export const PITCH_BEND_CENTER = 8192;

/** Data bytes expected after a status byte, by status nibble. */
function dataLength(status: number): number {
  const hi = status & 0xf0;
  if (hi === 0xc0 || hi === 0xd0) return 1;
  if (hi >= 0x80 && hi <= 0xe0) return 2;
  // System common messages with data; everything else (realtime, sysex) is 0 here.
  if (status === 0xf1 || status === 0xf3) return 1;
  if (status === 0xf2) return 2;
  return 0;
}

/**
 * Decode one complete channel message. `bytes[0]` must be a status byte.
 * Returns null for system messages and malformed input.
 */
export function decodeMidiMessage(bytes: ArrayLike<number>): MidiMessage | null {
  if (bytes.length === 0) return null;
  const status = bytes[0];
  if (status < 0x80 || status >= 0xf0) return null;
  const needed = dataLength(status);
  if (bytes.length < 1 + needed) return null;
  const channel = (status & 0x0f) + 1;
  const d1 = bytes[1] & 0x7f;
  const d2 = needed > 1 ? bytes[2] & 0x7f : 0;

  switch (status & 0xf0) {
    case 0x80:
      return { type: 'noteOff', channel, note: d1, velocity: d2 };
    case 0x90:
      // Note-on with velocity 0 is a note-off by convention (running status idiom).
      return d2 === 0 ? { type: 'noteOff', channel, note: d1, velocity: 0 } : { type: 'noteOn', channel, note: d1, velocity: d2 };
    case 0xa0:
      return { type: 'polyAftertouch', channel, note: d1, pressure: d2 };
    case 0xb0:
      return { type: 'controlChange', channel, controller: d1, value: d2 };
    case 0xc0:
      return { type: 'programChange', channel, program: d1 };
    case 0xd0:
      return { type: 'channelAftertouch', channel, pressure: d1 };
    case 0xe0:
      return { type: 'pitchBend', channel, value: d1 | (d2 << 7) };
    default:
      return null;
  }
}

export function controlIdFor(controller: number): ControlId {
  switch (controller) {
    case CC_MOD:
      return 'mod';
    case CC_VOLUME:
      return 'volume';
    case CC_EXPRESSION:
      return 'expression';
    case CC_SUSTAIN:
      return 'sustain';
    default:
      return controller;
  }
}

/** 14-bit pitch bend (0..16383, 8192 = rest) -> -1..1. */
export function bendToUnit(value14: number): number {
  const v = (value14 - PITCH_BEND_CENTER) / PITCH_BEND_CENTER;
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

/** Translate a decoded message into InputEvents (empty for messages the engine does not use). */
export function midiMessageToEvents(msg: MidiMessage, time: number, device: string): InputEvent[] {
  const base = { time, device, channel: msg.channel };
  switch (msg.type) {
    case 'noteOn':
      return [{ kind: 'noteOn', ...base, note: msg.note, velocity: clamp01(msg.velocity / 127) }];
    case 'noteOff':
      return [{ kind: 'noteOff', ...base, note: msg.note, velocity: clamp01(msg.velocity / 127) }];
    case 'controlChange':
      return [{ kind: 'control', ...base, control: controlIdFor(msg.controller), value: clamp01(msg.value / 127) }];
    case 'channelAftertouch':
      return [{ kind: 'control', ...base, control: 'aftertouch', value: clamp01(msg.pressure / 127) }];
    case 'pitchBend':
      return [{ kind: 'control', ...base, control: 'bend', value: bendToUnit(msg.value) }];
    case 'polyAftertouch':
    case 'programChange':
      return [];
  }
}

export interface MidiParserOptions {
  /** Only pass messages on this channel (1-16); undefined = omni. */
  channel?: number;
}

/**
 * Stateful byte-stream parser. Web MIDI delivers complete messages per
 * `midimessage` event, but running status (status byte omitted when it
 * repeats) and multiple messages per packet are legal, so `parse()` walks
 * the bytes and keeps the last status across calls.
 */
export class MidiParser {
  private readonly device: string;
  private channel: number | undefined;
  private runningStatus: number = 0;
  private inSysex: boolean = false;

  constructor(device: string, options: MidiParserOptions = {}) {
    this.device = device;
    this.channel = options.channel;
  }

  public setChannel(channel: number | undefined): void {
    this.channel = channel;
  }

  public getChannel(): number | undefined {
    return this.channel;
  }

  /** Parse a packet received at `time` (audio-context seconds). */
  public parse(data: ArrayLike<number>, time: number): InputEvent[] {
    const events: InputEvent[] = [];
    let i = 0;
    while (i < data.length) {
      const b = data[i];
      // System realtime (0xF8-0xFF) may appear anywhere, even inside sysex; it never changes running status.
      if (b >= 0xf8) {
        i++;
        continue;
      }
      if (this.inSysex) {
        if (b === 0xf7) this.inSysex = false;
        i++;
        continue;
      }
      let status: number;
      if (b >= 0x80) {
        status = b;
        i++;
        if (status === 0xf0) {
          this.inSysex = true;
          this.runningStatus = 0;
          continue;
        }
        if (status >= 0xf0) {
          // System common: cancels running status, data bytes skipped.
          this.runningStatus = 0;
          i += dataLength(status);
          continue;
        }
        this.runningStatus = status;
      } else {
        if (this.runningStatus === 0) {
          i++; // stray data byte
          continue;
        }
        status = this.runningStatus;
      }
      const needed = dataLength(status);
      if (i + needed > data.length) break; // truncated packet: drop the remainder
      const msg = decodeMidiMessage([status, data[i] ?? 0, data[i + 1] ?? 0]);
      i += needed;
      if (!msg) continue;
      if (this.channel !== undefined && msg.channel !== this.channel) continue;
      events.push(...midiMessageToEvents(msg, time, this.device));
    }
    return events;
  }
}

/** Encode an InputEvent back to MIDI bytes (for tests, scripts and MIDI out). Null when not representable. */
export function encodeMidiEvent(event: InputEvent): number[] | null {
  const ch = ((event.channel ?? 1) - 1) & 0x0f;
  const v7 = (x: number) => Math.max(0, Math.min(127, Math.round(clamp01(x) * 127)));
  switch (event.kind) {
    case 'noteOn':
      return [0x90 | ch, event.note & 0x7f, Math.max(1, v7(event.velocity))];
    case 'noteOff':
      return [0x80 | ch, event.note & 0x7f, v7(event.velocity ?? 0)];
    case 'control': {
      if (event.control === 'bend') {
        const v14 = Math.max(0, Math.min(16383, Math.round(PITCH_BEND_CENTER + event.value * PITCH_BEND_CENTER)));
        return [0xe0 | ch, v14 & 0x7f, (v14 >> 7) & 0x7f];
      }
      if (event.control === 'aftertouch') return [0xd0 | ch, v7(event.value)];
      const cc =
        typeof event.control === 'number'
          ? event.control
          : { mod: CC_MOD, volume: CC_VOLUME, expression: CC_EXPRESSION, sustain: CC_SUSTAIN }[event.control];
      return [0xb0 | ch, cc & 0x7f, v7(event.value)];
    }
    default:
      return null;
  }
}
