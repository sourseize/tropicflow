import { DEFAULT_PATTERN, clonePattern } from '../audio/AudioEngine.ts';
import { INITIAL_CABLES } from '../graph/NodeGraph.ts';
import { FULL_RACK } from '../modules/RackPreset.ts';
import type { RenderConfig } from './RenderConfig.ts';
import type { InputScript } from '../input/InputLog.ts';

export function defaultGrooveConfig(overrides: Partial<RenderConfig> = {}): RenderConfig {
  return {
    bpm: 118,
    swing: 0,
    bars: 2,
    sampleRate: 48000,
    tailSeconds: 1.0,
    pattern: clonePattern(DEFAULT_PATTERN),
    // The full studio, in rack format; the legacy per-module fields of a preset refine it.
    rack: { modules: FULL_RACK.modules.map((m) => ({ ...m, position: { ...m.position } })) },
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

/**
 * A short keyboard performance over the groove: single notes, a GM kick key,
 * a chord, a mod-wheel move. Times are relative to the first step.
 */
export function midiPerformanceScript(): InputScript {
  const d = 'script';
  return {
    version: 1,
    events: [
      { kind: 'noteOn', time: 0.0, device: d, note: 60, velocity: 0.9 },
      { kind: 'noteOff', time: 0.4, device: d, note: 60 },
      { kind: 'noteOn', time: 0.5, device: d, note: 64, velocity: 0.7 },
      { kind: 'noteOff', time: 0.9, device: d, note: 64 },
      { kind: 'noteOn', time: 1.0, device: d, note: 36, velocity: 1 },
      { kind: 'noteOff', time: 1.1, device: d, note: 36 },
      { kind: 'control', time: 1.2, device: d, control: 'mod', value: 0.8 },
      { kind: 'noteOn', time: 1.5, device: d, note: 67, velocity: 0.8 },
      { kind: 'noteOn', time: 1.5, device: d, note: 72, velocity: 0.8 },
      { kind: 'noteOff', time: 2.0, device: d, note: 67 },
      { kind: 'noteOff', time: 2.0, device: d, note: 72 },
      { kind: 'control', time: 2.1, device: d, control: 'mod', value: 0 },
    ],
  };
}

/** The default groove plus the performance above, GATE OUT patched to all three instruments. */
export function midiPerformanceConfig(overrides: Partial<RenderConfig> = {}): RenderConfig {
  return defaultGrooveConfig({
    cables: [
      ...INITIAL_CABLES.map((c) => ({ ...c })),
      { id: 'cable-midi-synth', fromNodeId: 'midi-1', fromPortId: 'midi-gate-out', toNodeId: 'synth-1', toPortId: 'syn-gate-in', color: '#FF6B35' },
      { id: 'cable-midi-drums', fromNodeId: 'midi-1', fromPortId: 'midi-gate-out', toNodeId: 'percussion-1', toPortId: 'perc-trig-in', color: '#FF382E' },
    ],
    inputScript: midiPerformanceScript(),
    ...overrides,
  });
}

/**
 * CV exercise, synth + marimba only, dry, no sequencer: a held synth note
 * whose filter the mod wheel opens half-way through, then a held note bent
 * up by the pitch wheel, then a note played while the bend is held.
 */
export function midiCvScript(): InputScript {
  const d = 'script';
  return {
    version: 1,
    events: [
      { kind: 'control', time: 0.0, device: d, control: 'mod', value: 0 },
      { kind: 'noteOn', time: 0.1, device: d, note: 48, velocity: 0.9 },
      { kind: 'control', time: 0.6, device: d, control: 'mod', value: 1 },
      { kind: 'noteOff', time: 1.1, device: d, note: 48 },
      { kind: 'control', time: 1.2, device: d, control: 'mod', value: 0 },
      { kind: 'noteOn', time: 1.5, device: d, note: 60, velocity: 0.9 },
      { kind: 'control', time: 2.0, device: d, control: 'bend', value: 1 },
      { kind: 'noteOff', time: 2.5, device: d, note: 60 },
      { kind: 'noteOn', time: 2.6, device: d, note: 60, velocity: 0.9 },
      { kind: 'noteOff', time: 2.9, device: d, note: 60 },
      { kind: 'control', time: 3.0, device: d, control: 'bend', value: 0 },
    ],
  };
}

export function midiCvConfig(overrides: Partial<RenderConfig> = {}): RenderConfig {
  return defaultGrooveConfig({
    pattern: { kick: EMPTY_ROW(), snare: EMPTY_ROW(), hihat: EMPTY_ROW(), marimba: EMPTY_ROW(), synth: EMPTY_ROW() },
    delay: { mix: 0 },
    cables: [
      ...INITIAL_CABLES.map((c) => ({ ...c })),
      { id: 'cable-midi-synth', fromNodeId: 'midi-1', fromPortId: 'midi-gate-out', toNodeId: 'synth-1', toPortId: 'syn-gate-in', color: '#FF6B35' },
      { id: 'cable-bend-marimba', fromNodeId: 'midi-1', fromPortId: 'midi-pitch-cv', toNodeId: 'marimba-1', toPortId: 'mrm-cv-in', color: '#FF9E00' },
    ],
    inputScript: midiCvScript(),
    ...overrides,
  });
}

/**
 * What a tracker would have published for someone humming over the groove:
 * C4 (the root), then D4 from the second bar, with two claps. Times relative
 * to the first step (bar = 2.034 s at 118 BPM).
 */
export function sensorFollowScript(): InputScript {
  const d = 'sensor:mic';
  const bar = (60 / 118) * 4;
  return {
    version: 1,
    events: [
      { kind: 'level', time: 0.0, device: d, rms: 0.1 },
      { kind: 'pitch', time: 0.05, device: d, hz: 261.63, clarity: 0.95 },
      { kind: 'onset', time: 0.6, device: d, strength: 0.9 },
      { kind: 'pitch', time: bar, device: d, hz: 293.66, clarity: 0.93 },
      { kind: 'level', time: bar, device: d, rms: 0.3 },
      { kind: 'onset', time: bar + 0.6, device: d, strength: 0.6 },
      { kind: 'level', time: 2 * bar - 0.2, device: d, rms: 0 },
    ],
  };
}

/** Default groove with the SENSE module's PITCH CV into the marimba and ONSET TRIG into the drums. */
export function sensorFollowConfig(overrides: Partial<RenderConfig> = {}): RenderConfig {
  return defaultGrooveConfig({
    cables: [
      ...INITIAL_CABLES.map((c) => ({ ...c })),
      { id: 'cable-sense-marimba', fromNodeId: 'sensor-1', fromPortId: 'sns-pitch-cv', toNodeId: 'marimba-1', toPortId: 'mrm-cv-in', color: '#FF9E00' },
      { id: 'cable-sense-drums', fromNodeId: 'sensor-1', fromPortId: 'sns-onset-out', toNodeId: 'percussion-1', toPortId: 'perc-trig-in', color: '#70E000' },
    ],
    inputScript: sensorFollowScript(),
    sensor: { rootNote: 60, onsetDrum: 'snare' },
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
  'midi-performance': () => midiPerformanceConfig(),
  'midi-cv': () => midiCvConfig(),
  'sensor-follow': () => sensorFollowConfig(),
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
