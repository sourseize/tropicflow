import { AudioEngine, type TrackId } from '../audio/AudioEngine.ts';
import { MasterBus } from '../audio/MasterBus.ts';
import type { RenderConfig, RenderResult, ScoreEvent } from './RenderConfig.ts';

/**
 * Measure the latency of the master bus by pushing a single-sample impulse
 * through it and locating the first non-zero output sample. The compressor's
 * lookahead makes this ~6 ms; we measure rather than assume so the score
 * stays correct on any Web Audio implementation.
 */
export async function measureBusLatency(sampleRate: number): Promise<number> {
  const length = Math.ceil(sampleRate * 0.1);
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length, sampleRate });
  const bus = new MasterBus(ctx);
  const impulse = ctx.createBuffer(1, 2, sampleRate);
  impulse.getChannelData(0)[0] = 1;
  const src = ctx.createBufferSource();
  src.buffer = impulse;
  src.connect(bus.inputNode);
  src.start(0);
  const out = await ctx.startRendering();
  const data = out.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    if (Math.abs(data[i]) > 1e-9) return i / sampleRate;
  }
  return 0;
}

/**
 * Render a config on an OfflineAudioContext using the exact same engine,
 * voices and clock as realtime playback. Deterministic: same config in,
 * same samples out (given the same Web Audio implementation).
 */
export async function renderOffline(config: RenderConfig): Promise<RenderResult> {
  const steps = config.bars * 16;

  // Pre-compute the duration with a throw-away clock so the buffer is sized exactly.
  const probe = new AudioEngineProbeClock(config.bpm, config.swing);
  const patternEnd = probe.durationForSteps(steps);
  const totalSeconds = patternEnd + config.tailSeconds;
  const length = Math.ceil(totalSeconds * config.sampleRate);

  // Four output channels: 0-1 = master output, 2-3 = pre-compressor tap.
  const ctx = new OfflineAudioContext({
    numberOfChannels: 4,
    length,
    sampleRate: config.sampleRate,
  });

  const engine = new AudioEngine({
    ctx,
    publishEvents: false,
    noiseSeed: config.noiseSeed,
    cables: config.cables,
    connectToDestination: false,
    chamber: config.chamber ? { ...config.chamber, enabled: config.chamber.enabled ?? true } : { enabled: false },
  });

  const merger = ctx.createChannelMerger(4);
  const masterSplit = ctx.createChannelSplitter(2);
  const tapSplit = ctx.createChannelSplitter(2);
  engine.masterBus.outputNode.connect(masterSplit);
  engine.masterBus.inputNode.connect(tapSplit);
  masterSplit.connect(merger, 0, 0);
  masterSplit.connect(merger, 1, 1);
  tapSplit.connect(merger, 0, 2);
  tapSplit.connect(merger, 1, 3);
  merger.connect(ctx.destination);

  applyParams(engine, config);
  engine.setPattern(config.pattern);
  if (config.solo) engine.setTrackMask(config.solo as TrackId[]);
  engine.clock.setBpm(config.bpm);
  engine.clock.setSwing(config.swing);

  const busLatency = await measureBusLatency(config.sampleRate);
  const score: ScoreEvent[] = [];
  engine.subscribeNotes((note) => {
    score.push({
      time: note.time,
      audibleTime: note.time + busLatency,
      source: note.source,
      step: note.step,
      track: note.track,
      frequency: note.frequency,
      velocity: note.velocity,
      collision: note.collision,
    });
  });

  engine.clock.reset(0);
  if (config.chamber) engine.chamber.start(0);
  engine.clock.advanceSteps(steps);
  if (config.chamber) engine.chamber.runTo(totalSeconds);
  score.sort((a, b) => a.time - b.time);

  const rendered = await ctx.startRendering();
  const channels = [rendered.getChannelData(0), rendered.getChannelData(1)];
  const tapChannels = [rendered.getChannelData(2), rendered.getChannelData(3)];
  return { sampleRate: rendered.sampleRate, channels, tapChannels, score, patternEnd, busLatency };
}

function applyParams(engine: AudioEngine, config: RenderConfig): void {
  if (config.masterVolume !== undefined) engine.masterBus.setVolume(config.masterVolume);
  if (config.synth) {
    for (const [k, v] of Object.entries(config.synth)) {
      engine.synth.updateParam(k as keyof typeof config.synth, v as never);
    }
  }
  if (config.marimba) {
    for (const [k, v] of Object.entries(config.marimba)) {
      engine.marimba.updateParam(k as keyof typeof config.marimba, v as number);
    }
  }
  if (config.percussion) {
    for (const [k, v] of Object.entries(config.percussion)) {
      engine.drums.updateParam(k as keyof typeof config.percussion, v as number);
    }
  }
  if (config.delay) {
    if (config.delay.time !== undefined) engine.delay.setDelayTime(config.delay.time);
    if (config.delay.feedback !== undefined) engine.delay.setFeedback(config.delay.feedback);
    if (config.delay.mix !== undefined) engine.delay.setMix(config.delay.mix);
  }
}

/** Tiny helper mirroring AudioClock.stepDuration without needing an audio context. */
class AudioEngineProbeClock {
  private readonly bpm: number;
  private readonly swing: number;

  constructor(bpm: number, swing: number) {
    this.bpm = bpm;
    this.swing = swing;
  }

  public durationForSteps(steps: number): number {
    const secondsPer16th = 60.0 / this.bpm / 4.0;
    let total = 0;
    for (let i = 0; i < steps; i++) {
      total += i % 2 === 0 ? secondsPer16th * (1 + this.swing) : secondsPer16th * (1 - this.swing);
    }
    return total;
  }
}
