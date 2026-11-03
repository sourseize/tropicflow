import { AudioEngine, clonePattern } from '../audio/AudioEngine.ts';
import type { RenderConfig } from './RenderConfig.ts';

/**
 * Snapshot the live engine state into a reproducible, serialisable render
 * config: the rack as it is (every module with its state), the cables, the
 * transport, and the last performance logged by the MIDI BRIDGE (keys / MIDI
 * played while the groove ran), so BOUNCE reproduces what was played.
 */
export function captureRenderConfig(engine: AudioEngine, bars: number, tailSeconds: number = 1.0): RenderConfig {
  const script = engine.input.log.toScript();
  const rack = engine.rack.toPreset(engine.getPatch());
  return {
    bpm: engine.clock.getBpm(),
    swing: engine.clock.getSwing(),
    bars,
    sampleRate: engine.ctx.sampleRate,
    tailSeconds,
    pattern: clonePattern(engine.getPattern()),
    rack: { modules: rack.modules },
    cables: rack.cables,
    masterVolume: engine.masterBus.getVolume(),
    inputScript: script.events.length > 0 ? script : undefined,
    bridge: { ...engine.input.getSettings() },
    sensor: { ...engine.input.getSensorSettings() },
  };
}
