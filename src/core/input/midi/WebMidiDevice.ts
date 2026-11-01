/**
 * Web MIDI adapter: `navigator.requestMIDIAccess()` -> MIDIInput messages ->
 * MidiParser -> InputEvents. Tracks hot-plugging and reports a status the UI
 * can show verbatim. Nothing here is called until the user enables MIDI
 * (browsers prompt for permission).
 *
 * Depends only on the subset of the Web MIDI API it uses (`MidiAccessLike`),
 * so tests can hand it a fake access object.
 */
import type { InputEvent } from '../InputEvents.ts';
import { midiDeviceId } from '../InputEvents.ts';
import { MidiParser } from './MidiParser.ts';

export interface MidiInputLike {
  id: string;
  name?: string | null;
  manufacturer?: string | null;
  state?: string;
  onmidimessage: ((ev: { data: Uint8Array | null; timeStamp: number }) => void) | null;
}

export interface MidiAccessLike {
  inputs: { forEach(cb: (input: MidiInputLike) => void): void; size?: number };
  onstatechange: ((ev: unknown) => void) | null;
}

export type MidiState = 'unsupported' | 'insecure' | 'idle' | 'requesting' | 'ready' | 'denied' | 'error';

export interface MidiInputInfo {
  id: string;
  name: string;
  manufacturer: string;
  connected: boolean;
}

export interface MidiStatus {
  state: MidiState;
  /** Human-readable explanation, suitable for the module's status line. */
  message: string;
  inputs: MidiInputInfo[];
  /** Input id the bridge listens to, or 'all'. */
  selected: string | 'all';
  /** MIDI channel filter 1-16, or undefined for omni. */
  channel: number | undefined;
}

export interface WebMidiDeviceDeps {
  stamp: (performanceMs: number) => number;
  publish: (events: InputEvent[]) => void;
  /** Defaults to `() => navigator.requestMIDIAccess()`; tests inject a fake. */
  requestAccess?: () => Promise<MidiAccessLike>;
  /** Defaults to `window.isSecureContext`. */
  isSecureContext?: () => boolean;
}

export type MidiStatusListener = (status: MidiStatus) => void;

/** Map a rejected requestMIDIAccess() to a state and message. */
export function describeMidiError(err: unknown): { state: MidiState; message: string } {
  const name = (err as { name?: string } | null)?.name ?? '';
  const text = err instanceof Error ? err.message : String(err);
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return { state: 'denied', message: 'MIDI permission refused: allow MIDI for this site in the browser and try again' };
  }
  if (name === 'InvalidStateError' || /platform dependent/i.test(text)) {
    return { state: 'error', message: 'MIDI could not start on this system (no MIDI service available)' };
  }
  return { state: 'error', message: `MIDI error: ${text}` };
}

export class WebMidiDevice {
  private readonly deps: WebMidiDeviceDeps;
  private access: MidiAccessLike | null = null;
  private readonly parsers: Map<string, MidiParser> = new Map();
  private status: MidiStatus;
  private readonly listeners: Set<MidiStatusListener> = new Set();

  constructor(deps: WebMidiDeviceDeps) {
    this.deps = deps;
    this.status = { state: this.initialState(), message: '', inputs: [], selected: 'all', channel: undefined };
    this.status.message = this.initialMessage(this.status.state);
  }

  private initialState(): MidiState {
    const hasApi =
      this.deps.requestAccess !== undefined ||
      (typeof navigator !== 'undefined' && typeof (navigator as Navigator).requestMIDIAccess === 'function');
    if (!hasApi) return 'unsupported';
    const secure = this.deps.isSecureContext ? this.deps.isSecureContext() : typeof window !== 'undefined' && window.isSecureContext;
    if (!secure) return 'insecure';
    return 'idle';
  }

  private initialMessage(state: MidiState): string {
    switch (state) {
      case 'unsupported':
        return 'Web MIDI is not available in this browser (use Chrome, Edge or Firefox 108+)';
      case 'insecure':
        return 'Web MIDI needs a secure context: open TROPICFLOW via http://localhost or https://';
      default:
        return 'MIDI off';
    }
  }

  public getStatus(): Readonly<MidiStatus> {
    return this.status;
  }

  public isEnabled(): boolean {
    return this.access !== null;
  }

  public subscribe(listener: MidiStatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Request access (may prompt). Resolves with the resulting status; never throws. */
  public async enable(): Promise<MidiStatus> {
    if (this.access) return this.status;
    if (this.status.state === 'unsupported' || this.status.state === 'insecure') return this.status;
    this.setStatus({ state: 'requesting', message: 'Requesting MIDI access...' });
    try {
      const request: () => Promise<MidiAccessLike> =
        this.deps.requestAccess ?? (() => navigator.requestMIDIAccess() as Promise<MidiAccessLike>);
      const access = await request();
      this.access = access;
      access.onstatechange = () => this.refreshInputs();
      this.refreshInputs();
    } catch (err) {
      this.setStatus(describeMidiError(err));
    }
    return this.status;
  }

  public disable(): void {
    if (!this.access) return;
    this.access.inputs.forEach((input) => {
      input.onmidimessage = null;
    });
    this.access.onstatechange = null;
    this.access = null;
    this.parsers.clear();
    this.setStatus({ state: 'idle', message: 'MIDI off', inputs: [] });
  }

  /** Listen to one input (by id) or all of them. */
  public selectInput(selected: string | 'all'): void {
    this.status = { ...this.status, selected };
    if (this.access) this.refreshInputs();
    else this.notify();
  }

  public setChannel(channel: number | undefined): void {
    this.status = { ...this.status, channel };
    for (const p of this.parsers.values()) p.setChannel(channel);
    this.notify();
  }

  /** Re-read the input list (hot-plug) and (re)attach message handlers. */
  public refreshInputs(): void {
    if (!this.access) return;
    const inputs: MidiInputInfo[] = [];
    const seen = new Set<string>();
    this.access.inputs.forEach((input) => {
      seen.add(input.id);
      inputs.push({
        id: input.id,
        name: input.name || `MIDI input ${input.id}`,
        manufacturer: input.manufacturer || '',
        connected: input.state === undefined || input.state === 'connected',
      });
      const listen = this.status.selected === 'all' || this.status.selected === input.id;
      if (!listen) {
        input.onmidimessage = null;
        return;
      }
      let parser = this.parsers.get(input.id);
      if (!parser) {
        parser = new MidiParser(midiDeviceId(input.id), { channel: this.status.channel });
        this.parsers.set(input.id, parser);
      }
      const p = parser;
      input.onmidimessage = (ev) => {
        if (!ev.data) return;
        const events = p.parse(ev.data, this.deps.stamp(ev.timeStamp));
        if (events.length) this.deps.publish(events);
      };
    });
    for (const id of Array.from(this.parsers.keys())) if (!seen.has(id)) this.parsers.delete(id);
    const listening = inputs.filter((i) => this.status.selected === 'all' || this.status.selected === i.id);
    const message =
      inputs.length === 0
        ? 'MIDI ready: no input devices found (plug in a keyboard, it is picked up automatically)'
        : listening.length === 0
          ? 'MIDI ready: the selected input is not connected'
          : `MIDI ready: listening to ${listening.map((i) => i.name).join(', ')}`;
    this.setStatus({ state: 'ready', message, inputs });
  }

  private setStatus(patch: Partial<MidiStatus>): void {
    this.status = { ...this.status, ...patch };
    this.notify();
  }

  private notify(): void {
    for (const l of Array.from(this.listeners)) l(this.status);
  }
}
