/**
 * Owns the single realtime AudioContext used by the UI.
 *
 * DSP classes no longer reach for this singleton themselves; they receive a
 * BaseAudioContext in their constructor. That lets the exact same voices run
 * on an OfflineAudioContext for deterministic WAV rendering and tests.
 */
export class AudioContextManager {
  private static instance: AudioContextManager;
  private ctx: AudioContext | null = null;

  private constructor() {}

  public static getInstance(): AudioContextManager {
    if (!AudioContextManager.instance) {
      AudioContextManager.instance = new AudioContextManager();
    }
    return AudioContextManager.instance;
  }

  public getContext(): AudioContext {
    if (!this.ctx) {
      const AudioContextClass =
        window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioContextClass({ latencyHint: 'interactive' });
    }
    return this.ctx;
  }

  public async resumeIfNeeded(): Promise<void> {
    const context = this.getContext();
    if (context.state === 'suspended') {
      await context.resume();
    }
  }

  public get currentTime(): number {
    return this.getContext().currentTime;
  }

  public get sampleRate(): number {
    return this.getContext().sampleRate;
  }

  public get isRunning(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }
}

/** True when the context is a realtime AudioContext (has resume/suspend). */
export function isRealtimeContext(ctx: BaseAudioContext): ctx is AudioContext {
  return typeof (ctx as AudioContext).resume === 'function' && !('startRendering' in ctx);
}

/**
 * Disconnect a transient voice sub-graph once its source has finished.
 * Replaces the previous setTimeout-based cleanup, which depended on wall-clock
 * time and therefore could not work for offline (faster-than-realtime) renders.
 */
export function disconnectOnEnded(source: AudioScheduledSourceNode, ...nodes: AudioNode[]): void {
  source.addEventListener('ended', () => {
    for (const node of nodes) {
      try {
        node.disconnect();
      } catch {
        /* already disconnected */
      }
    }
  });
}
