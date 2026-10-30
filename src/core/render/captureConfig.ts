import { AudioEngine, clonePattern } from '../audio/AudioEngine.ts';
import type { RenderConfig } from './RenderConfig.ts';

/** Snapshot the live engine state into a reproducible, serialisable render config. */
export function captureRenderConfig(engine: AudioEngine, bars: number, tailSeconds: number = 1.0): RenderConfig {
  return {
    bpm: engine.clock.getBpm(),
    swing: engine.clock.getSwing(),
    bars,
    sampleRate: engine.ctx.sampleRate,
    tailSeconds,
    pattern: clonePattern(engine.getPattern()),
    cables: engine.getPatch(),
    masterVolume: engine.masterBus.getVolume(),
    synth: { ...engine.synth.getParams() },
    marimba: { ...engine.marimba.getParams() },
    percussion: { ...engine.drums.getParams() },
    delay: { ...engine.delay.getParams() },
    chamber: engine.chamber.isEnabled() ? engine.chamber.exportConfig() : undefined,
  };
}
