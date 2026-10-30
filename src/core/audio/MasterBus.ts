export class MasterBus {
  public readonly inputNode: GainNode;
  public readonly outputNode: GainNode;
  public readonly analyserNode: AnalyserNode;
  private readonly compressorNode: DynamicsCompressorNode;
  private readonly ctx: BaseAudioContext;
  private volume: number = 0.85;

  /**
   * @param connectToDestination Pass false to leave the output unconnected
   *        (offline renders route it through a channel merger instead).
   */
  constructor(ctx: BaseAudioContext, connectToDestination: boolean = true) {
    this.ctx = ctx;

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
    if (connectToDestination) this.outputNode.connect(ctx.destination);

    this.outputNode.gain.setValueAtTime(this.volume, ctx.currentTime);
  }

  public setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1.2, volume));
    this.outputNode.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.02);
  }

  public getVolume(): number {
    return this.volume;
  }

  public getWaveformData(array: Uint8Array<ArrayBuffer>): void {
    this.analyserNode.getByteTimeDomainData(array);
  }

  public getFrequencyData(array: Uint8Array<ArrayBuffer>): void {
    this.analyserNode.getByteFrequencyData(array);
  }
}
