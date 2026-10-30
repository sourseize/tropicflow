import { DEFAULT_PATTERN, clonePattern } from '../audio/AudioEngine.ts';
import { INITIAL_CABLES } from '../graph/NodeGraph.ts';
import type { RenderConfig } from './RenderConfig.ts';

export function defaultGrooveConfig(overrides: Partial<RenderConfig> = {}): RenderConfig {
  return {
    bpm: 118,
    swing: 0,
    bars: 2,
    sampleRate: 48000,
    tailSeconds: 1.0,
    pattern: clonePattern(DEFAULT_PATTERN),
    cables: INITIAL_CABLES.map((c) => ({ ...c })),
    ...overrides,
  };
}

const EMPTY_ROW = () => new Array(16).fill(false) as boolean[];

/** Three balls dropped into the default pegs, no sequencer, dry: pure physics-driven notes. */
export function chamberOnlyConfig(overrides: Partial<RenderConfig> = {}): RenderConfig {
  return defaultGrooveConfig({
    bars: 4,
    tailSeconds: 1.5,
    pattern: { kick: EMPTY_ROW(), snare: EMPTY_ROW(), hihat: EMPTY_ROW(), marimba: EMPTY_ROW(), synth: EMPTY_ROW() },
    delay: { mix: 0 },
    chamber: {
      enabled: true,
      quantize: 0,
      autoDropBars: 0,
      physics: {
        seed: 7,
        balls: [
          { x: 0.31, y: 0.05 },
          { x: 0.6, y: 0.05, vx: 0.3 },
          { x: 0.47, y: 0.2, vx: -0.5 },
        ],
      },
    },
    ...overrides,
  });
}

export const RENDER_PRESETS: Record<string, () => RenderConfig> = {
  'default-groove': () => defaultGrooveConfig(),
  'drums-only': () =>
    defaultGrooveConfig({
      cables: INITIAL_CABLES.filter(
        (c) => c.id === 'cable-2' || c.id === 'cable-6'
      ),
    }),
  'silence': () =>
    defaultGrooveConfig({
      cables: [],
    }),
  'chamber-only': () => chamberOnlyConfig(),
  'chamber-groove': () =>
    chamberOnlyConfig({
      pattern: clonePattern(DEFAULT_PATTERN),
      delay: undefined,
      chamber: {
        enabled: true,
        quantize: 0,
        autoDropBars: 1,
        dropX: 0.35,
        physics: { seed: 7, balls: [] },
      },
    }),
};
