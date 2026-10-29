import { AudioContextManager } from './AudioContextManager';

export class MasterBus {
  public readonly inputNode: GainNode;
  public readonly outputNode: GainNode;
  public readonly analyserNode: AnalyserNode;
  private readonly compressorNode: DynamicsCompressorNode;
  private readonly ctxManager: AudioContextManager;

  constructor() {
    this.ctxManager = AudioContextManager.getInstance();
    const ctx = this.ctxManager.getContext();

    this.inputNode = ctx.createGain();
    this.outputNode = ctx.createGain();
    this.analyserNode = ctx.createAnalyser();
    this.compressorNode = ctx.createDynamicsCompressor();

    this.analyserNode.fftSize = 1024;
    this.analyserNode.smoothingTimeConstant = 0.85;

    this.compressorNode.threshold.setValueAtTime(-3, ctx.currentTime);
    this.compressorNode.knee.setValueAtTime(6, ctx.currentTime);
    this.compressorNode.ratio.setValueAtTime(8, ctx.currentTime);
    this.compressorNode.attack.setValueAtTime(0.003, ctx.currentTime);
    this.compressorNode.release.setValueAtTime(0.15, ctx.currentTime);

    this.inputNode.connect(this.compressorNode);
    this.compressorNode.connect(this.analyserNode);
    this.analyserNode.connect(this.outputNode);
    this.outputNode.connect(ctx.destination);

    this.outputNode.gain.setValueAtTime(0.85, ctx.currentTime);
  }

  public setVolume(volume: number): void {
    const clamped = Math.max(0, Math.min(1.2, volume));
    const ctx = this.ctxManager.getContext();
    this.outputNode.gain.setTargetAtTime(clamped, ctx.currentTime, 0.02);
  }

  public getWaveformData(array: Uint8Array<ArrayBuffer>): void {
    this.analyserNode.getByteTimeDomainData(array);
  }

  public getFrequencyData(array: Uint8Array<ArrayBuffer>): void {
    this.analyserNode.getByteFrequencyData(array);
  }
}
