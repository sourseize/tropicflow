/**
 * Realtime wiring of the input devices to the engine's InputBinding:
 * timestamp mapping (getOutputTimestamp polling), the computer keyboard,
 * Web MIDI, raw-byte injection (console / tests) and realtime replay of a
 * logged performance. Exposed as `window.tropicflowInput`.
 */
import { AudioEngine } from '../audio/AudioEngine.ts';
import { isRealtimeContext } from '../audio/AudioContextManager.ts';
import { type InputEvent, midiDeviceId } from './InputEvents.ts';
import { type InputScript, ScriptPlayer, parseInputScript } from './InputLog.ts';
import { DEFAULT_INPUT_LATENCY, TimestampMapper } from './TimestampMapper.ts';
import { KeyboardDevice } from './keyboard/KeyboardDevice.ts';
import { MidiParser } from './midi/MidiParser.ts';
import { WebMidiDevice, type WebMidiDeviceDeps } from './midi/WebMidiDevice.ts';
import { SensorEngine, type SensorEngineDeps } from '../sense/SensorEngine.ts';

/** Replay tick (cheap: nothing happens unless a script is playing). */
const POLL_MS = 25;
/**
 * How often the output timestamp is sampled in the background. Kept low:
 * `getOutputTimestamp()` touches the audio thread's position, and polling it
 * at 40 Hz measurably worsened scheduling jitter in headless Chromium. A
 * fresh sample is also taken whenever an event needs stamping.
 */
const TIMESTAMP_POLL_MS = 100;
/** How far ahead replayed script events are released (matches the clock's lookahead). */
const REPLAY_AHEAD = 0.1;
/** Device id for bytes injected through `send()` (console, e2e tests). */
export const VIRTUAL_MIDI_DEVICE = midiDeviceId('virtual');

export interface InputHubOptions {
  keyboardTarget?: EventTarget;
  requestMidiAccess?: WebMidiDeviceDeps['requestAccess'];
  getUserMedia?: SensorEngineDeps['getUserMedia'];
}

export class InputHub {
  private static instance: InputHub | null = null;

  public readonly mapper: TimestampMapper = new TimestampMapper();
  public readonly keyboard: KeyboardDevice;
  public readonly midi: WebMidiDevice;
  /** SENSE module: microphone / virtual voice tracker. */
  public readonly sensor: SensorEngine;
  private readonly engine: AudioEngine;
  private readonly virtualParser: MidiParser = new MidiParser(VIRTUAL_MIDI_DEVICE);
  private latency: number = DEFAULT_INPUT_LATENCY;
  private player: ScriptPlayer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly replayListeners: Set<(remaining: number) => void> = new Set();

  constructor(engine: AudioEngine, options: InputHubOptions = {}) {
    this.engine = engine;
    const stamp = (ms: number) => this.stamp(ms);
    const publish = (events: InputEvent[]) => this.publish(events);
    this.keyboard = new KeyboardDevice({ stamp, publish, target: options.keyboardTarget });
    this.midi = new WebMidiDevice({ stamp, publish, requestAccess: options.requestMidiAccess });
    this.sensor = new SensorEngine(engine, { getUserMedia: options.getUserMedia });
  }

  /** Realtime singleton bound to the UI engine (created on first use, keyboard enabled, polling started). */
  public static getInstance(): InputHub {
    if (!InputHub.instance) {
      InputHub.instance = new InputHub(AudioEngine.getInstance());
      InputHub.instance.keyboard.enable();
      InputHub.instance.start();
    }
    return InputHub.instance;
  }

  /** Start polling the output timestamp and releasing replayed events. Idempotent. */
  public start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), POLL_MS);
    this.tick();
  }

  public stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** User-chosen latency floor added to every device event (seconds). */
  public getLatency(): number {
    return this.latency;
  }

  public setLatency(seconds: number): void {
    this.latency = Math.max(0, Math.min(0.5, seconds));
  }

  /**
   * Latency actually applied: the floor, or the context's own output path
   * (base + output latency + a 5 ms margin) when that is longer. The mapper's
   * samples live on the *output* timeline, which lags `currentTime` by that
   * much; anything shorter would be clamped to "now" and jitter with the
   * main thread instead of keeping the performance's exact spacing.
   */
  public effectiveLatency(): number {
    const ctx = this.engine.ctx as AudioContext;
    const device = (Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0) + (Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : 0);
    return Math.max(this.latency, device + 0.005);
  }

  /** Audio-context time at which an event stamped `performanceMs` is scheduled. */
  public stamp(performanceMs: number): number {
    this.sampleTimestamp();
    return this.mapper.scheduleTime(performanceMs, this.engine.ctx.currentTime, this.effectiveLatency());
  }

  private lastSampleAt: number = -Infinity;

  /** Feed the mapper a fresh output timestamp (at most once per few ms). */
  private sampleTimestamp(force: boolean = false): void {
    const now = performance.now();
    if (!force && now - this.lastSampleAt < 5) return;
    const ctx = this.engine.ctx;
    if (isRealtimeContext(ctx) && typeof ctx.getOutputTimestamp === 'function') {
      this.lastSampleAt = now;
      this.mapper.update(ctx.getOutputTimestamp());
    }
  }

  public publish(events: InputEvent[]): void {
    this.engine.input.bus.publishAll(events);
  }

  /**
   * Inject raw MIDI bytes as if a device had sent them at `performanceMs`
   * (default: now). Returns the events produced. For the console and tests:
   * `tropicflowInput.send([0x90, 60, 100])`.
   */
  public send(bytes: ArrayLike<number>, performanceMs: number = performance.now()): InputEvent[] {
    const events = this.virtualParser.parse(bytes, this.stamp(performanceMs));
    this.publish(events);
    return events;
  }

  /** Replay a script in realtime starting now (validates it first). Replaces a running replay. */
  public playScript(script: InputScript | unknown): ScriptPlayer {
    const parsed = parseInputScript(script);
    this.player = new ScriptPlayer(parsed, this.engine.ctx.currentTime + REPLAY_AHEAD);
    this.start();
    this.notifyReplay();
    return this.player;
  }

  /** Replay the performance logged during the last run of the transport. */
  public replayLog(): ScriptPlayer | null {
    const script = this.engine.input.log.toScript();
    if (script.events.length === 0) return null;
    return this.playScript(script);
  }

  public stopScript(): void {
    if (!this.player) return;
    this.player = null;
    this.engine.input.releaseAll(this.engine.ctx.currentTime);
    this.notifyReplay();
  }

  public isReplaying(): boolean {
    return this.player !== null && !this.player.isDone();
  }

  public subscribeReplay(listener: (remaining: number) => void): () => void {
    this.replayListeners.add(listener);
    return () => {
      this.replayListeners.delete(listener);
    };
  }

  private tick(): void {
    const ctx = this.engine.ctx;
    if (performance.now() - this.lastSampleAt >= TIMESTAMP_POLL_MS) this.sampleTimestamp(true);
    if (this.player) {
      const events = this.player.runTo(ctx.currentTime + REPLAY_AHEAD);
      if (events.length) this.publish(events);
      if (this.player.isDone()) {
        this.player = null;
        this.notifyReplay();
      } else if (events.length) {
        this.notifyReplay();
      }
    }
  }

  private notifyReplay(): void {
    const remaining = this.player?.remaining() ?? 0;
    for (const l of Array.from(this.replayListeners)) l(remaining);
  }
}
