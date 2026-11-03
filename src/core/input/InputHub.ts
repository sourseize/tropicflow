/**
 * Realtime input services shared by the modules that own devices (MIDI
 * BRIDGE: computer keys + Web MIDI; SENSE: microphone / virtual voice):
 * timestamp mapping (getOutputTimestamp polling, ref-counted: it only runs
 * while a device or a replay needs it), raw-byte injection (console / tests)
 * and realtime replay of a logged performance. Engine-owned; exposed as
 * `window.tropicflowInput`. The devices themselves are reached through the
 * rack (`keyboard`, `midi`, `sensor` resolve the modules in the rack).
 */
import type { AudioEngine } from '../audio/AudioEngine.ts';
import { isRealtimeContext } from '../audio/AudioContextManager.ts';
import { type InputEvent, midiDeviceId } from './InputEvents.ts';
import { type InputScript, ScriptPlayer, parseInputScript } from './InputLog.ts';
import { DEFAULT_INPUT_LATENCY, TimestampMapper } from './TimestampMapper.ts';
import type { KeyboardDevice } from './keyboard/KeyboardDevice.ts';
import { MidiParser } from './midi/MidiParser.ts';
import type { WebMidiDevice } from './midi/WebMidiDevice.ts';
import type { SensorEngine } from '../sense/SensorEngine.ts';
import type { InputService } from '../modules/ModuleContract.ts';
import type { MidiModule } from '../../modules/midi/module.ts';
import type { SensorModule } from '../../modules/sensor/module.ts';

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

export class InputHub implements InputService {
  public readonly mapper: TimestampMapper = new TimestampMapper();
  private readonly engine: AudioEngine;
  private readonly virtualParser: MidiParser = new MidiParser(VIRTUAL_MIDI_DEVICE);
  private latency: number = DEFAULT_INPUT_LATENCY;
  private player: ScriptPlayer | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Devices holding the poll (see acquirePoll). */
  private pollHolders = 0;
  private readonly replayListeners: Set<(remaining: number) => void> = new Set();

  constructor(engine: AudioEngine) {
    this.engine = engine;
  }

  // -------------------------------------------------------------------
  // Devices live in their modules; these resolve them for panels, console and tests
  // -------------------------------------------------------------------

  private module<T>(type: 'midi' | 'sensor'): T {
    const m = this.engine.rack.findByType(type);
    if (!m) throw new Error(`no ${type === 'midi' ? 'MIDI BRIDGE' : 'SENSE'} module in the rack`);
    return m as unknown as T;
  }

  /** The MIDI BRIDGE's computer-keys device (throws when the module is not in the rack). */
  public get keyboard(): KeyboardDevice {
    return this.module<MidiModule>('midi').keyboard;
  }

  /** The MIDI BRIDGE's Web MIDI device (throws when the module is not in the rack). */
  public get midi(): WebMidiDevice {
    return this.module<MidiModule>('midi').midi;
  }

  /** The SENSE module's tracker (throws when the module is not in the rack). */
  public get sensor(): SensorEngine {
    return this.module<SensorModule>('sensor').sensor;
  }

  // -------------------------------------------------------------------
  // Polling: runs only while a device or a replay needs it
  // -------------------------------------------------------------------

  /** Hold the poll; the returned function releases it (idempotent). */
  public acquirePoll(): () => void {
    this.pollHolders++;
    this.start();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pollHolders--;
      this.stopIfIdle();
    };
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

  public isPolling(): boolean {
    return this.timer !== null;
  }

  private stopIfIdle(): void {
    if (this.pollHolders === 0 && !this.player) this.stop();
  }

  public subscribe(listener: (event: InputEvent) => void): () => void {
    return this.engine.input.bus.subscribe(listener);
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
    this.stopIfIdle();
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
        this.stopIfIdle();
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
