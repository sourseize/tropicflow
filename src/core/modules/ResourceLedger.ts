/**
 * Per-module resource accounting. A module acquires its AudioNodes, timers,
 * animation loops, media streams and event listeners through its ledger; the
 * ledger counts them, and `release()` frees whatever is still held. This is
 * what makes "removing a module unloads it" a number the tests can check
 * (`rack.inspect()`), not a promise.
 *
 * Pure: the browser functions are injected so the ledger is unit-testable in
 * Node, and an OfflineAudioContext works the same as a realtime one.
 */

export interface ResourceCounts {
  audioNodes: number;
  timers: number;
  animationLoops: number;
  streams: number;
  listeners: number;
}

export const EMPTY_COUNTS: Readonly<ResourceCounts> = Object.freeze({ audioNodes: 0, timers: 0, animationLoops: 0, streams: 0, listeners: 0 });

export function addCounts(a: ResourceCounts, b: ResourceCounts): ResourceCounts {
  return {
    audioNodes: a.audioNodes + b.audioNodes,
    timers: a.timers + b.timers,
    animationLoops: a.animationLoops + b.animationLoops,
    streams: a.streams + b.streams,
    listeners: a.listeners + b.listeners,
  };
}

export interface LedgerDeps {
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  requestAnimationFrame: (fn: (time: number) => void) => number;
  cancelAnimationFrame: (handle: number) => void;
}

/** Browser defaults; absent in Node (tests inject their own). */
function defaultDeps(): LedgerDeps {
  const g = globalThis as unknown as Partial<LedgerDeps>;
  return {
    setInterval: g.setInterval ?? (() => 0),
    clearInterval: g.clearInterval ?? (() => {}),
    requestAnimationFrame: g.requestAnimationFrame ?? (() => 0),
    cancelAnimationFrame: g.cancelAnimationFrame ?? (() => {}),
  };
}

interface ListenerEntry {
  target: EventTarget;
  type: string;
  fn: EventListenerOrEventListenerObject;
  options?: boolean | AddEventListenerOptions;
}

export class ResourceLedger {
  private readonly nodes: Set<AudioNode> = new Set();
  private readonly timers: Set<unknown> = new Set();
  private readonly loops: Set<{ handle: number; stopped: boolean }> = new Set();
  private readonly streams: Set<MediaStream> = new Set();
  private readonly listeners: Set<ListenerEntry> = new Set();
  private readonly deps: LedgerDeps;
  private released = false;

  public readonly ctx: BaseAudioContext;

  constructor(ctx: BaseAudioContext, deps: Partial<LedgerDeps> = {}) {
    this.ctx = ctx;
    this.deps = { ...defaultDeps(), ...deps };
  }

  // -------------------------------------------------------------------
  // Audio nodes: create through the ledger, or adopt nodes created elsewhere
  // -------------------------------------------------------------------

  /** Adopt an existing node (used when wrapping classes that build their own graph). */
  public adopt<T extends AudioNode>(node: T): T {
    this.nodes.add(node);
    return node;
  }

  /** Forget a node that finished on its own (e.g. a one-shot source after `ended`). */
  public forget(node: AudioNode): void {
    this.nodes.delete(node);
  }

  public gain(): GainNode {
    return this.adopt(this.ctx.createGain());
  }

  public oscillator(): OscillatorNode {
    return this.adopt(this.ctx.createOscillator());
  }

  public biquad(): BiquadFilterNode {
    return this.adopt(this.ctx.createBiquadFilter());
  }

  public delay(maxSeconds?: number): DelayNode {
    return this.adopt(this.ctx.createDelay(maxSeconds));
  }

  public analyser(): AnalyserNode {
    return this.adopt(this.ctx.createAnalyser());
  }

  public bufferSource(): AudioBufferSourceNode {
    return this.adopt(this.ctx.createBufferSource());
  }

  public compressor(): DynamicsCompressorNode {
    return this.adopt(this.ctx.createDynamicsCompressor());
  }

  public splitter(channels?: number): ChannelSplitterNode {
    return this.adopt(this.ctx.createChannelSplitter(channels));
  }

  public merger(channels?: number): ChannelMergerNode {
    return this.adopt(this.ctx.createChannelMerger(channels));
  }

  // -------------------------------------------------------------------
  // Timers and animation loops
  // -------------------------------------------------------------------

  public setInterval(fn: () => void, ms: number): () => void {
    const handle = this.deps.setInterval(fn, ms);
    this.timers.add(handle);
    return () => {
      if (!this.timers.delete(handle)) return;
      this.deps.clearInterval(handle);
    };
  }

  /** Run `fn` every animation frame until the returned stop function is called. */
  public animate(fn: (time: number) => void): () => void {
    const loop = { handle: 0, stopped: false };
    const tick = (time: number) => {
      if (loop.stopped) return;
      fn(time);
      if (!loop.stopped) loop.handle = this.deps.requestAnimationFrame(tick);
    };
    loop.handle = this.deps.requestAnimationFrame(tick);
    this.loops.add(loop);
    return () => {
      if (loop.stopped) return;
      loop.stopped = true;
      this.deps.cancelAnimationFrame(loop.handle);
      this.loops.delete(loop);
    };
  }

  // -------------------------------------------------------------------
  // Media streams and event listeners
  // -------------------------------------------------------------------

  public stream(stream: MediaStream): MediaStream {
    this.streams.add(stream);
    return stream;
  }

  public stopStream(stream: MediaStream): void {
    if (!this.streams.delete(stream)) return;
    for (const track of stream.getTracks()) track.stop();
  }

  public listen(
    target: EventTarget,
    type: string,
    fn: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): () => void {
    const entry: ListenerEntry = { target, type, fn, options };
    target.addEventListener(type, fn, options);
    this.listeners.add(entry);
    return () => {
      if (!this.listeners.delete(entry)) return;
      target.removeEventListener(type, fn, options);
    };
  }

  // -------------------------------------------------------------------
  // Accounting
  // -------------------------------------------------------------------

  public counts(): ResourceCounts {
    return {
      audioNodes: this.nodes.size,
      timers: this.timers.size,
      animationLoops: this.loops.size,
      streams: this.streams.size,
      listeners: this.listeners.size,
    };
  }

  public isReleased(): boolean {
    return this.released;
  }

  /** Free everything still held. Idempotent. */
  public release(): void {
    this.released = true;
    for (const handle of this.timers) this.deps.clearInterval(handle);
    this.timers.clear();
    for (const loop of this.loops) {
      loop.stopped = true;
      this.deps.cancelAnimationFrame(loop.handle);
    }
    this.loops.clear();
    for (const entry of this.listeners) entry.target.removeEventListener(entry.type, entry.fn, entry.options);
    this.listeners.clear();
    for (const stream of this.streams) for (const track of stream.getTracks()) track.stop();
    this.streams.clear();
    for (const node of this.nodes) {
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.nodes.clear();
  }
}
