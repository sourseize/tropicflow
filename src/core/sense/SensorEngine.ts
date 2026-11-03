/**
 * The SENSE module's realtime half: a microphone (getUserMedia) and/or the
 * keyboard-driven VirtualVoice feed one AnalyserNode; a poll every ~16 ms
 * runs the level/onset detector over the newly arrived samples and the pitch
 * detector over the last frame, and publishes the resulting InputEvents
 * (pitch / level / onset, device `sensor:mic` or `sensor:voice`) on the
 * engine's input bus - the same bus MIDI and scripts use, so the events are
 * logged, replayed and rendered like any other input.
 *
 * The analyser is polled rather than an AudioWorklet: it works without a
 * secure context for the virtual voice, costs nothing on the audio thread,
 * and ~10-20 ms of onset latency is fine for a trigger source (phase 3b of
 * the plan moves to a worklet if that ever matters).
 */
import { isRealtimeContext } from '../audio/AudioContextManager.ts';
import { type InputEvent, SENSOR_MIC_DEVICE, SENSOR_VOICE_DEVICE } from '../input/InputEvents.ts';
import { frameSizeFor } from './PitchDetector.ts';
import { type SensorOptions, type SensorReading, SensorTracker } from './SensorAnalysis.ts';
import { VirtualVoice } from './VirtualVoice.ts';

export type MicState = 'unsupported' | 'insecure' | 'idle' | 'requesting' | 'ready' | 'denied' | 'error';

export interface SensorStatus {
  mic: MicState;
  micMessage: string;
  voice: boolean;
  /** Label of the capture device when known. */
  micLabel: string;
}

/** What the tracker needs from its module host: the context, a resume for the mic gesture, the input bus. */
export interface SensorEngineHost {
  ctx: BaseAudioContext;
  resume(): Promise<void>;
  publish(events: InputEvent[]): void;
  subscribe(listener: (event: InputEvent) => void): () => void;
}

export interface SensorEngineDeps {
  /** Defaults to navigator.mediaDevices.getUserMedia; tests inject a fake. */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  isSecureContext?: () => boolean;
  /**
   * Where the AnalyserNode comes from. Chromium never frees an analyser that
   * has had an input connected (infinite tail), so the SENSE module hands
   * out pooled analysers that are reused by the next instance.
   */
  analyserPool?: { acquire(ctx: BaseAudioContext): AnalyserNode | null; release(node: AnalyserNode): void };
}

export interface SensorConfig extends SensorOptions {
  /** Input gain applied before analysis (the tracker's floor is -45 dBFS). */
  gain: number;
}

export const DEFAULT_SENSOR_CONFIG: SensorConfig = { gain: 1, clarityThreshold: 0.8 };

const POLL_MS = 16;
const LEVEL_BLOCK = 256;
/**
 * The analyser keeps this many samples (the maximum: ~743 ms at 44.1 kHz):
 * the level detector consumes whatever arrived since the previous poll, so a
 * main thread stalled for up to that long loses nothing (stalls of ~200 ms
 * were measured in headless Chromium under test load). Pitch uses the tail.
 */
const ANALYSER_SIZE = 32768;
/** UI listeners are notified at most this often (the events themselves are never throttled). */
const UI_NOTIFY_MS = 50;

export function describeMicError(err: unknown): { state: MicState; message: string } {
  const name = (err as { name?: string } | null)?.name ?? '';
  const text = err instanceof Error ? err.message : String(err);
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return { state: 'denied', message: 'Microphone permission refused: allow the microphone for this site and try again' };
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return { state: 'error', message: 'No microphone found on this system' };
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return { state: 'error', message: 'The microphone is in use by another application or could not be read' };
  }
  return { state: 'error', message: `Microphone error: ${text}` };
}

export class SensorEngine {
  public readonly voice: VirtualVoice;
  private readonly engine: SensorEngineHost;
  private readonly deps: SensorEngineDeps;
  /** Gain stage in front of the analyser (mic and virtual voice sum here). */
  public readonly inputNode: GainNode;
  private readonly analyser: AnalyserNode | null;
  private readonly frame: Float32Array<ArrayBuffer>;
  private readonly pitchFrameSize: number;
  private lastNotify = 0;
  private micTracker: SensorTracker;
  private voiceTracker: SensorTracker;
  private config: SensorConfig = { ...DEFAULT_SENSOR_CONFIG };
  private status: SensorStatus;
  private stream: MediaStream | null = null;
  private micSource: MediaStreamAudioSourceNode | null = null;
  private voiceOn = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPollTime = 0;
  private readonly listeners: Set<(status: SensorStatus, reading: SensorReading) => void> = new Set();
  private unsubscribeBus: (() => void) | null = null;

  constructor(engine: SensorEngineHost, deps: SensorEngineDeps = {}) {
    this.engine = engine;
    this.deps = deps;
    const ctx = engine.ctx;
    this.inputNode = ctx.createGain();
    this.inputNode.gain.value = this.config.gain;
    this.analyser = deps.analyserPool ? deps.analyserPool.acquire(ctx) : typeof ctx.createAnalyser === 'function' ? ctx.createAnalyser() : null;
    this.pitchFrameSize = frameSizeFor(ctx.sampleRate, 60);
    if (this.analyser) {
      this.analyser.fftSize = Math.max(ANALYSER_SIZE, this.pitchFrameSize);
      this.analyser.smoothingTimeConstant = 0;
      this.inputNode.connect(this.analyser);
    }
    this.frame = new Float32Array(this.analyser?.fftSize ?? ANALYSER_SIZE);
    this.voice = new VirtualVoice(ctx);
    this.voice.outputNode.connect(this.inputNode);
    this.micTracker = new SensorTracker(SENSOR_MIC_DEVICE, this.config);
    this.voiceTracker = new SensorTracker(SENSOR_VOICE_DEVICE, this.config);
    this.status = { mic: this.initialMicState(), micMessage: '', voice: false, micLabel: '' };
    this.status.micMessage = this.initialMessage(this.status.mic);
  }

  private initialMicState(): MicState {
    const hasApi = this.deps.getUserMedia !== undefined || (typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia);
    if (!hasApi) return 'unsupported';
    const secure = this.deps.isSecureContext ? this.deps.isSecureContext() : typeof window !== 'undefined' && window.isSecureContext;
    if (!secure) return 'insecure';
    return 'idle';
  }

  private initialMessage(state: MicState): string {
    switch (state) {
      case 'unsupported':
        return 'Microphone capture is not available in this browser';
      case 'insecure':
        return 'The microphone needs a secure context: open TROPICFLOW via http://localhost or https://';
      default:
        return 'Mic off';
    }
  }

  // -------------------------------------------------------------------
  // Status / config
  // -------------------------------------------------------------------

  public getStatus(): Readonly<SensorStatus> {
    return this.status;
  }

  public getConfig(): Readonly<SensorConfig> {
    return this.config;
  }

  public updateConfig(patch: Partial<SensorConfig>): void {
    this.config = { ...this.config, ...patch };
    if (patch.gain !== undefined) this.inputNode.gain.setTargetAtTime(patch.gain, this.engine.ctx.currentTime, 0.02);
    if (patch.clarityThreshold !== undefined || patch.pitch !== undefined || patch.level !== undefined) {
      // Trackers are cheap: rebuild them with the new options.
      this.rebuildTrackers();
    }
  }

  private rebuildTrackers(): void {
    this.micTracker = new SensorTracker(SENSOR_MIC_DEVICE, this.config);
    this.voiceTracker = new SensorTracker(SENSOR_VOICE_DEVICE, this.config);
  }

  /** Latest raw analysis (tuner / meter). Mic and voice share the analyser; one tracker reports. */
  public getReading(): Readonly<SensorReading> {
    return this.activeTracker().getReading();
  }

  public subscribe(listener: (status: SensorStatus, reading: SensorReading) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public isActive(): boolean {
    return this.stream !== null || this.voiceOn;
  }

  /** The analyser node (tests can tap it). */
  public getAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  // -------------------------------------------------------------------
  // Microphone
  // -------------------------------------------------------------------

  public async enableMic(): Promise<SensorStatus> {
    if (this.stream) return this.status;
    if (this.status.mic === 'unsupported' || this.status.mic === 'insecure') return this.status;
    this.setStatus({ mic: 'requesting', micMessage: 'Requesting microphone access...' });
    try {
      const request = this.deps.getUserMedia ?? ((c: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(c));
      const stream = await request({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
      await this.engine.resume();
      const ctx = this.engine.ctx;
      if (!isRealtimeContext(ctx)) throw new Error('microphone input needs a realtime AudioContext');
      this.micSource = ctx.createMediaStreamSource(stream);
      this.micSource.connect(this.inputNode);
      this.stream = stream;
      const label = stream.getAudioTracks()[0]?.label ?? '';
      stream.getAudioTracks()[0]?.addEventListener('ended', () => this.disableMic('The microphone was disconnected'));
      this.micTracker.reset();
      this.setStatus({ mic: 'ready', micMessage: `Mic on${label ? `: ${label}` : ''}`, micLabel: label });
      this.ensurePolling();
    } catch (err) {
      const { state, message } = describeMicError(err);
      this.setStatus({ mic: state, micMessage: message });
    }
    return this.status;
  }

  public disableMic(message: string = 'Mic off'): void {
    if (!this.stream) return;
    for (const t of this.stream.getTracks()) t.stop();
    this.micSource?.disconnect();
    this.micSource = null;
    this.stream = null;
    this.setStatus({ mic: 'idle', micMessage: message, micLabel: '' });
    this.stopPollingIfIdle();
  }

  // -------------------------------------------------------------------
  // Virtual voice (computer keys)
  // -------------------------------------------------------------------

  /** Let the computer keys sing through the virtual voice (Space = clap). */
  public setVoiceEnabled(on: boolean): void {
    if (on === this.voiceOn) return;
    this.voiceOn = on;
    if (on) {
      void this.engine.resume();
      this.voice.start();
      this.voiceTracker.reset();
      this.unsubscribeBus = this.engine.subscribe((e) => this.onBusEvent(e));
      this.ensurePolling();
    } else {
      this.unsubscribeBus?.();
      this.unsubscribeBus = null;
      this.voice.releaseAll();
      this.stopPollingIfIdle();
    }
    this.setStatus({ voice: on });
  }

  public isVoiceEnabled(): boolean {
    return this.voiceOn;
  }

  private onBusEvent(e: InputEvent): void {
    if (e.device !== 'keys') return;
    if (e.kind === 'noteOn') this.voice.noteOn(e.note, e.time);
    else if (e.kind === 'noteOff') this.voice.noteOff(e.note, e.time);
    else if (e.kind === 'onset') this.voice.clap(e.strength, e.time);
  }

  // -------------------------------------------------------------------
  // Polling
  // -------------------------------------------------------------------

  private activeTracker(): SensorTracker {
    return this.stream ? this.micTracker : this.voiceTracker;
  }

  private ensurePolling(): void {
    if (this.timer !== null || !this.analyser) return;
    this.lastPollTime = this.engine.ctx.currentTime;
    this.timer = setInterval(() => this.poll(), POLL_MS);
  }

  private stopPollingIfIdle(): void {
    if (this.isActive() || this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private poll(): void {
    if (!this.analyser) return;
    const ctx = this.engine.ctx;
    const now = ctx.currentTime;
    const sr = ctx.sampleRate;
    this.analyser.getFloatTimeDomainData(this.frame);
    const tracker = this.activeTracker();
    const events: InputEvent[] = [];

    // Samples that arrived since the last poll, in LEVEL_BLOCK-sized blocks ending at `now`.
    const fresh = Math.min(this.frame.length, Math.max(0, Math.round((now - this.lastPollTime) * sr)));
    this.lastPollTime = now;
    const blocks = Math.floor(fresh / LEVEL_BLOCK);
    for (let b = blocks; b >= 1; b--) {
      const end = this.frame.length - (b - 1) * LEVEL_BLOCK;
      const start = end - LEVEL_BLOCK;
      events.push(...tracker.analyseLevel(this.frame.subarray(start, end), now - (this.frame.length - start) / sr));
    }
    events.push(...tracker.analysePitch(this.frame.subarray(this.frame.length - this.pitchFrameSize), sr, now));

    if (events.length) this.engine.publish(events);
    const wall = performance.now();
    if (wall - this.lastNotify >= UI_NOTIFY_MS) {
      this.lastNotify = wall;
      const reading = tracker.getReading();
      for (const l of Array.from(this.listeners)) l(this.status, reading);
    }
  }

  private setStatus(patch: Partial<SensorStatus>): void {
    this.status = { ...this.status, ...patch };
    const reading = this.activeTracker().getReading();
    for (const l of Array.from(this.listeners)) l(this.status, reading);
  }

  /** Mic off, voice off, poll stopped, every node torn down. Idempotent. */
  public dispose(): void {
    this.disableMic();
    this.setVoiceEnabled(false);
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.listeners.clear();
    this.voice.dispose();
    this.inputNode.disconnect();
    if (this.analyser) {
      this.analyser.disconnect();
      this.deps.analyserPool?.release(this.analyser);
    }
  }
}
