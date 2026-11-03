/**
 * Turns InputEvents into engine notes: the MIDI BRIDGE's "GATE OUT".
 *
 * Every note-on is fired from the `midi-gate-out` jack; the cables from it
 * decide which modules sound (AudioEngine.playNote routes by jack, exactly
 * like the clock and the chamber). The synth holds
 * its note until the matching note-off; marimba and drums are one-shots.
 *
 * Same code for realtime (devices publish into `bus`) and offline rendering
 * (a ScriptPlayer publishes a RenderConfig.inputScript), so a logged
 * performance bounces exactly as it was played.
 */
import type { AudioEngine } from '../audio/AudioEngine.ts';
import type { NoteCommand } from '../physics/CollisionMapper.ts';
import { InputBus } from './InputBus.ts';
import { InputLog } from './InputLog.ts';
import { type ControlId, type InputEvent, deviceKind, hzToMidiNote, midiNoteToHz } from './InputEvents.ts';
import { levelToUnit, rmsToDb } from '../sense/LevelOnset.ts';

export interface DrumMapping {
  track: 'kick' | 'snare' | 'hihat';
  open?: boolean;
}

/** General MIDI percussion keys the TOMATO DRUMS understand. */
export const GM_DRUM_MAP: Readonly<Record<number, DrumMapping>> = {
  35: { track: 'kick' },
  36: { track: 'kick' },
  37: { track: 'snare' }, // side stick
  38: { track: 'snare' },
  40: { track: 'snare' },
  42: { track: 'hihat', open: false },
  44: { track: 'hihat', open: false }, // pedal
  46: { track: 'hihat', open: true },
};

export interface BridgeSettings {
  /** Semitones added to every incoming note. */
  transpose: number;
  /** A4 reference for note -> Hz. */
  a4Hz: number;
  /** Pitch bend range in semitones: full bend (-1..1) -> +-bendRange on the PITCH CV jack. */
  bendRange: number;
}

export const DEFAULT_BRIDGE_SETTINGS: BridgeSettings = { transpose: 0, a4Hz: 440, bendRange: 2 };

/** Jacks of the MIDI BRIDGE (canonical instance). */
export const MIDI_GATE_OUT = 'midi-gate-out';
export const MIDI_PITCH_CV = 'midi-pitch-cv';
export const MIDI_MOD_CV = 'midi-mod-cv';
/** Jacks of the SENSE module. */
export const SENSOR_PITCH_CV = 'sns-pitch-cv';
export const SENSOR_LEVEL_CV = 'sns-level-cv';
export const SENSOR_ONSET_OUT = 'sns-onset-out';

export interface SensorSettings {
  /** MIDI note the tracked pitch is measured against: singing it gives PITCH CV = 0. */
  rootNote: number;
  /** Drum an onset fires when ONSET TRIG is patched into the drums. */
  onsetDrum: 'kick' | 'snare' | 'hihat';
  /** Gate length of synth notes fired by onsets (s). */
  onsetSynthDuration: number;
}

export const DEFAULT_SENSOR_SETTINGS: SensorSettings = { rootNote: 60, onsetDrum: 'kick', onsetSynthDuration: 0.18 };

export interface BridgeActivity {
  /** Last note-on seen (any device). */
  lastNote: { note: number; velocity: number; device: string; time: number } | null;
  /** Latest value per control (mod, bend, ...). */
  controls: Map<ControlId, number>;
  /** Currently held notes: hold id -> note. */
  held: Map<string, number>;
  /** Total events handled. */
  count: number;
  /** Last tracked pitch from the sensor (Hz), null when unclear. */
  sensorHz: number | null;
  /** Last sensor level 0..1 and onset strength. */
  sensorLevel: number;
  lastOnset: { strength: number; time: number } | null;
}

export type ActivityListener = (event: InputEvent, activity: BridgeActivity) => void;

export function holdId(device: string, note: number): string {
  return `${device}/${note}`;
}

export class InputBinding {
  public readonly bus: InputBus = new InputBus();
  /** Records the performance while the transport runs (see AudioEngine.startAudio). */
  public readonly log: InputLog = new InputLog();
  private readonly engine: AudioEngine;
  private settings: BridgeSettings = { ...DEFAULT_BRIDGE_SETTINGS };
  private sensorSettings: SensorSettings = { ...DEFAULT_SENSOR_SETTINGS };
  private readonly activity: BridgeActivity = { lastNote: null, controls: new Map(), held: new Map(), count: 0, sensorHz: null, sensorLevel: 0, lastOnset: null };
  private readonly listeners: Set<ActivityListener> = new Set();
  /** Devices whose notes are ignored (the module's KEYS / MIDI toggles); events are still logged and shown. */
  private readonly muted: Set<string> = new Set();

  constructor(engine: AudioEngine) {
    this.engine = engine;
    this.bus.subscribe((e) => this.handle(e));
  }

  public getSettings(): Readonly<BridgeSettings> {
    return this.settings;
  }

  public updateSettings(patch: Partial<BridgeSettings>): void {
    this.settings = { ...this.settings, ...patch };
    if (patch.bendRange !== undefined) this.publishBend(this.engine.ctx.currentTime);
  }

  private publishBend(when: number): void {
    const bend = this.activity.controls.get('bend') ?? 0;
    this.engine.setCvSource(MIDI_PITCH_CV, bend * this.settings.bendRange, when);
  }

  public getSensorSettings(): Readonly<SensorSettings> {
    return this.sensorSettings;
  }

  public updateSensorSettings(patch: Partial<SensorSettings>): void {
    this.sensorSettings = { ...this.sensorSettings, ...patch };
  }

  public getActivity(): Readonly<BridgeActivity> {
    return this.activity;
  }

  /** Mute a device's notes at the bridge (e.g. KEYS OFF while the virtual voice still uses the keys). */
  public setDeviceMuted(device: string, muted: boolean): void {
    if (muted) {
      this.muted.add(device);
      for (const [id, note] of Array.from(this.activity.held)) {
        if (id.startsWith(`${device}/`)) {
          this.engine.releaseHeld(id, this.engine.ctx.currentTime);
          this.activity.held.delete(id);
          void note;
        }
      }
    } else {
      this.muted.delete(device);
    }
  }

  public isDeviceMuted(device: string): boolean {
    return this.muted.has(device);
  }

  /** Observe handled events (UI activity LED, key lights). */
  public subscribe(listener: ActivityListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Frequency an incoming note plays at, after transpose. */
  public frequencyFor(note: number): number {
    return midiNoteToHz(note + this.settings.transpose, this.settings.a4Hz);
  }

  /** Release every held note, e.g. when a device is disabled or the window loses focus. */
  public releaseAll(when: number): void {
    for (const id of Array.from(this.activity.held.keys())) {
      this.engine.releaseHeld(id, when);
      this.activity.held.delete(id);
    }
  }

  private handle(event: InputEvent): void {
    this.log.record(event);
    this.activity.count++;
    const muted = this.muted.has(event.device);
    switch (event.kind) {
      case 'noteOn': {
        if (muted) break;
        const id = holdId(event.device, event.note);
        const frequency = this.frequencyFor(event.note);
        this.engine.playNote({ track: 'marimba', frequency, velocity: event.velocity }, event.time, MIDI_GATE_OUT);
        this.engine.playNote({ track: 'synth', frequency, velocity: event.velocity }, event.time, MIDI_GATE_OUT, { holdId: id });
        const drum = GM_DRUM_MAP[event.note];
        if (drum) {
          const cmd: NoteCommand = { track: drum.track, velocity: event.velocity };
          if (drum.track === 'hihat') cmd.open = drum.open ?? false;
          this.engine.playNote(cmd, event.time, MIDI_GATE_OUT);
        }
        this.activity.held.set(id, event.note);
        this.activity.lastNote = { note: event.note, velocity: event.velocity, device: event.device, time: event.time };
        break;
      }
      case 'noteOff': {
        if (muted) break;
        const id = holdId(event.device, event.note);
        this.engine.releaseHeld(id, event.time);
        this.activity.held.delete(id);
        break;
      }
      case 'control':
        if (muted) break;
        this.activity.controls.set(event.control, event.value);
        if (event.control === 'mod') this.engine.setCvSource(MIDI_MOD_CV, event.value, event.time);
        else if (event.control === 'bend') this.publishBend(event.time);
        break;
      case 'pitch': {
        if (deviceKind(event.device) !== 'sensor') break;
        this.activity.sensorHz = event.hz;
        this.engine.setCvSource(SENSOR_PITCH_CV, hzToMidiNote(event.hz) - this.sensorSettings.rootNote, event.time);
        break;
      }
      case 'level': {
        if (deviceKind(event.device) !== 'sensor') break;
        const level = levelToUnit(rmsToDb(event.rms));
        this.activity.sensorLevel = level;
        this.engine.setCvSource(SENSOR_LEVEL_CV, level, event.time);
        break;
      }
      case 'onset': {
        // Only the sensor's own onsets fire ONSET TRIG (a keys "tap" is the virtual voice's clap, not a trigger).
        if (deviceKind(event.device) !== 'sensor') break;
        this.activity.lastOnset = { strength: event.strength, time: event.time };
        // A detected onset lies slightly in the past: sound it now, never before the timeline.
        const when = Math.max(event.time, this.engine.ctx.currentTime);
        const velocity = Math.max(0.2, event.strength);
        // Onset notes sound at the root; patch PITCH CV into the module to have them follow the voice.
        const frequency = midiNoteToHz(this.sensorSettings.rootNote, this.settings.a4Hz);
        const drum = this.sensorSettings.onsetDrum;
        const drumCmd: NoteCommand = { track: drum, velocity };
        if (drum === 'hihat') drumCmd.open = false;
        this.engine.playNote(drumCmd, when, SENSOR_ONSET_OUT);
        this.engine.playNote({ track: 'marimba', frequency, velocity }, when, SENSOR_ONSET_OUT);
        this.engine.playNote({ track: 'synth', frequency, velocity, duration: this.sensorSettings.onsetSynthDuration }, when, SENSOR_ONSET_OUT);
        break;
      }
    }
    for (const l of Array.from(this.listeners)) l(event, this.activity);
  }
}
