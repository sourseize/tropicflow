/**
 * Records "what you hear": taps an AudioNode (the master bus output) through
 * an AudioWorklet and accumulates the raw Float32 samples in memory.
 *
 * The worklet processor runs on the audio rendering thread, so capture is
 * sample-accurate and never glitches because of UI work. Blocks are batched
 * before being posted to the main thread to keep message overhead low.
 *
 * The processor source is inlined and loaded through a Blob URL: no bundler
 * configuration, no extra network request, works fully offline.
 */

export interface Take {
  /** One Float32Array per channel (always 2: the master bus is stereo). */
  channels: Float32Array[];
  sampleRate: number;
  durationSeconds: number;
  /** Wall-clock time (Date.now()) at which the take started. */
  recordedAt: number;
  /**
   * Audio-context time of the first captured sample, so a note scheduled at
   * context time `t` sits at `t - startContextTime` (+ bus latency) in the
   * take. Sample-exact when `syncExact` is true.
   */
  startContextTime: number;
  /**
   * True when the origin was measured from the sync marker (a constant
   * source scheduled at a known time on the worklet's second input); false
   * when the take was too short (< 0.1 s) for the marker to arrive and the
   * main-thread clock at connect time was used instead (within a few ms).
   */
  syncExact: boolean;
  /** Tempo when the take started (used for the file name). */
  bpm: number;
}

export type TakeStopReason = 'stopped' | 'max-length' | 'empty';

export interface TakeRecorderOptions {
  /** Longest take allowed, in seconds (default 60, hard ceiling 600). */
  maxSeconds?: number;
  /** Called when the take reaches `maxSeconds` and is finalised automatically. */
  onMaxLengthReached?: (take: Take) => void;
}

export const TAKE_MAX_SECONDS_CEILING = 600;
export const TAKE_DEFAULT_MAX_SECONDS = 60;
const CHANNELS = 2;
/** Frames batched per message from the worklet (~93 ms at 44.1 kHz). */
const BATCH_FRAMES = 4096;
/** How far ahead the sync marker is scheduled (must exceed main-thread clock staleness). */
const SYNC_MARKER_DELAY = 0.1;

/**
 * Source of the AudioWorkletProcessor. Kept as a string (not a module) so it
 * can be loaded from a Blob URL without any build-tool support for worklets.
 */
const PROCESSOR_SOURCE = `
class TropicflowTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batch = [new Float32Array(${BATCH_FRAMES}), new Float32Array(${BATCH_FRAMES})];
    this.fill = 0;
    this.captured = 0;
    this.syncFrame = -1;
    this.running = true;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') {
        this.flush();
        this.port.postMessage({ type: 'stopped' });
        this.running = false;
      }
    };
  }
  silence(n) {
    if (!this.zeros || this.zeros.length !== n) this.zeros = new Float32Array(n);
    return this.zeros;
  }
  flush() {
    if (this.fill === 0) return;
    const out = [this.batch[0].slice(0, this.fill), this.batch[1].slice(0, this.fill)];
    this.port.postMessage({ type: 'data', frames: this.fill, syncFrame: this.syncFrame, channels: out }, [out[0].buffer, out[1].buffer]);
    this.fill = 0;
  }
  process(inputs) {
    if (!this.running) return false;
    const input = inputs[0];
    const n = (input && input.length > 0) ? input[0].length : 128;
    // Sync marker on input 1: a constant source that starts at a known context time.
    const marker = inputs[1] && inputs[1][0];
    if (this.syncFrame < 0 && marker) {
      for (let k = 0; k < marker.length; k++) {
        if (marker[k] > 0.5) { this.syncFrame = this.captured + k; break; }
      }
    }
    this.captured += n;
    // No connected/active source: record silence for this block.
    const left = (input && input.length > 0) ? input[0] : this.silence(n);
    const right = (input && input.length > 1) ? input[1] : left;
    let i = 0;
    while (i < n) {
      const room = ${BATCH_FRAMES} - this.fill;
      const take = Math.min(room, n - i);
      this.batch[0].set(left.subarray(i, i + take), this.fill);
      this.batch[1].set(right.subarray(i, i + take), this.fill);
      this.fill += take;
      i += take;
      if (this.fill === ${BATCH_FRAMES}) this.flush();
    }
    return true;
  }
}
registerProcessor('tropicflow-tap', TropicflowTapProcessor);
`;

interface DataMessage {
  type: 'data';
  frames: number;
  /** Index (in captured frames) where the sync marker rose, -1 until seen. */
  syncFrame: number;
  channels: Float32Array[];
}
interface StoppedMessage {
  type: 'stopped';
}
type WorkletMessage = DataMessage | StoppedMessage;

/** A captured block: stereo frames plus, once seen, where the sync marker rose. */
interface TapBlock {
  frames: number;
  channels: Float32Array[];
  /** Index (in captured frames) where the marker rose, -1 until seen. */
  syncFrame: number;
}

/**
 * Capture backend. `start()` resolves once the tap is part of the graph and
 * returns the context time the marker is scheduled at; `stop()` resolves once
 * the last block has been delivered.
 */
interface Tap {
  start(onBlock: (b: TapBlock) => void): Promise<{ connectTime: number; markerTime: number }>;
  stop(): Promise<void>;
}

/** Sync marker: a constant source scheduled on the Web Audio timeline. */
function startMarker(ctx: BaseAudioContext, connectTo: AudioNode, input: number): { node: ConstantSourceNode; connectTime: number; markerTime: number } {
  const connectTime = ctx.currentTime;
  const node = new ConstantSourceNode(ctx, { offset: 1 });
  node.connect(connectTo, 0, input);
  const markerTime = connectTime + SYNC_MARKER_DELAY;
  node.start(markerTime);
  return { node, connectTime, markerTime };
}

function safeDisconnect(...nodes: Array<AudioNode | null>): void {
  for (const n of nodes) {
    try {
      n?.disconnect();
    } catch {
      /* already disconnected */
    }
  }
}

/** Preferred backend: AudioWorklet (needs a secure context: https:// or localhost). */
class WorkletTap implements Tap {
  private static modules = new WeakMap<BaseAudioContext, Promise<void>>();
  private node: AudioWorkletNode | null = null;
  private marker: ConstantSourceNode | null = null;
  private readonly ctx: BaseAudioContext;
  private readonly source: AudioNode;

  // No parameter properties: Node's type stripping (used by the unit tests) cannot handle them.
  constructor(ctx: BaseAudioContext, source: AudioNode) {
    this.ctx = ctx;
    this.source = source;
  }

  public static isSupported(ctx: BaseAudioContext): boolean {
    return typeof AudioWorkletNode !== 'undefined' && !!ctx.audioWorklet;
  }

  private ensureModule(): Promise<void> {
    let loaded = WorkletTap.modules.get(this.ctx);
    if (!loaded) {
      const url = URL.createObjectURL(new Blob([PROCESSOR_SOURCE], { type: 'text/javascript' }));
      loaded = this.ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
      loaded.catch(() => WorkletTap.modules.delete(this.ctx));
      WorkletTap.modules.set(this.ctx, loaded);
    }
    return loaded;
  }

  public async start(onBlock: (b: TapBlock) => void): Promise<{ connectTime: number; markerTime: number }> {
    await this.ensureModule();
    const node = new AudioWorkletNode(this.ctx, 'tropicflow-tap', {
      numberOfInputs: 2,
      numberOfOutputs: 1,
      outputChannelCount: [CHANNELS],
      channelCount: CHANNELS,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });
    node.port.onmessage = (e: MessageEvent<WorkletMessage>) => {
      if (e.data.type === 'data') onBlock(e.data);
    };
    this.source.connect(node, 0, 0);
    // A worklet only runs while it is part of the live graph; its output is silent.
    node.connect(this.ctx.destination);
    const marker = startMarker(this.ctx, node, 1);
    this.marker = marker.node;
    this.node = node;
    return { connectTime: marker.connectTime, markerTime: marker.markerTime };
  }

  public stop(): Promise<void> {
    const node = this.node;
    if (!node) return Promise.resolve();
    this.node = null;
    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        node.port.onmessage = null;
        try {
          this.source.disconnect(node);
        } catch {
          /* already disconnected */
        }
        this.marker?.stop();
        safeDisconnect(this.marker, node);
        this.marker = null;
        resolve();
      };
      const onBlock = node.port.onmessage as ((e: MessageEvent<WorkletMessage>) => void) | null;
      node.port.onmessage = (e: MessageEvent<WorkletMessage>) => {
        onBlock?.(e);
        if (e.data.type === 'stopped') finish();
      };
      node.port.postMessage('stop');
      // Safety net: a suspended context never runs the processor, so never replies.
      setTimeout(finish, 500);
    });
  }
}

export class TakeRecorder {
  private readonly ctx: BaseAudioContext;
  private readonly source: AudioNode;
  private maxSeconds: number;
  private onMaxLengthReached?: (take: Take) => void;

  private tap: Tap | null = null;
  private chunks: Float32Array[][] = [];
  private frames = 0;
  private syncFrame = -1;
  private markerTime = 0;
  private connectTime = 0;
  private recording = false;
  private startedAt = 0;
  private bpmAtStart = 0;
  private stopping: Promise<Take | null> | null = null;

  constructor(ctx: BaseAudioContext, source: AudioNode, options: TakeRecorderOptions = {}) {
    this.ctx = ctx;
    this.source = source;
    this.maxSeconds = clampMaxSeconds(options.maxSeconds ?? TAKE_DEFAULT_MAX_SECONDS);
    this.onMaxLengthReached = options.onMaxLengthReached;
  }

  /**
   * True when AudioWorklet is available, i.e. a modern browser in a secure
   * context (https:// or localhost). There is deliberately no
   * ScriptProcessorNode fallback: measured in Chromium, it drops or repeats
   * whole render quanta when the main thread is busy, so its takes are not
   * trustworthy.
   */
  public static isSupported(ctx: BaseAudioContext): boolean {
    return WorkletTap.isSupported(ctx);
  }

  /** Human-readable reason recording is unavailable, or null when it is. */
  public static unsupportedReason(ctx: BaseAudioContext): string | null {
    if (WorkletTap.isSupported(ctx)) return null;
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      return 'Recording needs a secure context: open TROPICFLOW via http://localhost or https://';
    }
    return 'Recording needs AudioWorklet support (a current Chrome, Edge, Firefox or Safari)';
  }

  public isRecording(): boolean {
    return this.recording;
  }

  /** Seconds captured so far in the current take (0 when idle). */
  public getElapsedSeconds(): number {
    return this.recording ? this.frames / this.ctx.sampleRate : 0;
  }

  public getMaxSeconds(): number {
    return this.maxSeconds;
  }

  /** Change the length limit; clamped to [1, TAKE_MAX_SECONDS_CEILING]. Applies to the running take too. */
  public setMaxSeconds(seconds: number): void {
    this.maxSeconds = clampMaxSeconds(seconds);
    if (this.recording && this.frames >= this.maxSeconds * this.ctx.sampleRate) this.finishAtMaxLength();
  }

  /**
   * Start capturing. Resolves once the tap is connected, i.e. from then on
   * every sample leaving the source is recorded.
   */
  public async start(bpm: number): Promise<void> {
    if (this.recording) return;
    if (this.stopping) await this.stopping;
    const reason = TakeRecorder.unsupportedReason(this.ctx);
    if (reason) throw new Error(reason);

    this.chunks = [];
    this.frames = 0;
    this.syncFrame = -1;
    this.startedAt = Date.now();
    this.bpmAtStart = bpm;

    const tap: Tap = new WorkletTap(this.ctx, this.source);
    const { connectTime, markerTime } = await tap.start((block) => this.onBlock(block));
    this.connectTime = connectTime;
    this.markerTime = markerTime;
    this.tap = tap;
    this.recording = true;
  }

  /**
   * Stop capturing and return the take, or null when nothing was captured.
   * Waits for the tap to deliver its last block.
   */
  public stop(): Promise<Take | null> {
    if (!this.recording) return this.stopping ?? Promise.resolve(null);
    const tap = this.tap!;
    this.recording = false;
    this.tap = null;
    this.stopping = tap.stop().then(() => {
      this.stopping = null;
      return this.assembleTake();
    });
    return this.stopping;
  }

  // -------------------------------------------------------------------

  private onBlock(block: TapBlock): void {
    if (!this.recording && !this.stopping) return;
    if (this.syncFrame < 0 && block.syncFrame >= 0) this.syncFrame = block.syncFrame;
    const limit = Math.floor(this.maxSeconds * this.ctx.sampleRate);
    const room = limit - this.frames;
    if (room <= 0) return;
    const frames = Math.min(block.frames, room);
    const chunk = frames === block.frames ? block.channels : block.channels.map((c) => c.subarray(0, frames));
    this.chunks.push(chunk);
    this.frames += frames;
    if (this.recording && this.frames >= limit) this.finishAtMaxLength();
  }

  private finishAtMaxLength(): void {
    void this.stop().then((take) => {
      if (take && this.onMaxLengthReached) this.onMaxLengthReached(take);
    });
  }

  private assembleTake(): Take | null {
    if (this.frames === 0) return null;
    const channels: Float32Array[] = [];
    for (let c = 0; c < CHANNELS; c++) {
      const out = new Float32Array(this.frames);
      let offset = 0;
      for (const chunk of this.chunks) {
        out.set(chunk[c], offset);
        offset += chunk[c].length;
      }
      channels.push(out);
    }
    const take: Take = {
      channels,
      sampleRate: this.ctx.sampleRate,
      durationSeconds: this.frames / this.ctx.sampleRate,
      recordedAt: this.startedAt,
      startContextTime: this.syncFrame >= 0 ? this.markerTime - this.syncFrame / this.ctx.sampleRate : this.connectTime,
      syncExact: this.syncFrame >= 0,
      bpm: this.bpmAtStart,
    };
    this.chunks = [];
    this.frames = 0;
    return take;
  }
}

export function clampMaxSeconds(seconds: number): number {
  if (!Number.isFinite(seconds)) return TAKE_DEFAULT_MAX_SECONDS;
  return Math.max(1, Math.min(TAKE_MAX_SECONDS_CEILING, seconds));
}
