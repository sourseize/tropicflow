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
