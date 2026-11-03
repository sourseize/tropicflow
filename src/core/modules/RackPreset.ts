/**
 * A serialisable description of a rack: which modules (by type), their ids
 * and positions on the canvas, optional state, and the cables between them.
 * `DEFAULT_RACK` is the patch the app starts with and RESET PATCH restores.
 */
import type { GraphNode, PatchCable } from '../graph/GraphTypes.ts';
import type { ModuleRegistry } from './ModuleRegistry.ts';
import { type ModuleDescriptor, type ModuleState, portFromSpec } from './ModuleContract.ts';

export interface RackModuleEntry {
  type: string;
  id: string;
  position: { x: number; y: number };
  state?: ModuleState;
}

export interface RackPreset {
  modules: RackModuleEntry[];
  cables: PatchCable[];
}

/** The canvas node of a rack entry. */
export function nodeFor(descriptor: ModuleDescriptor, entry: RackModuleEntry): GraphNode {
  const ports = descriptor.ports.map((spec) => portFromSpec(spec, descriptor.type, entry.id));
  return {
    id: entry.id,
    title: descriptor.title,
    type: descriptor.type as GraphNode['type'],
    position: { ...entry.position },
    inputs: ports.filter((p) => p.direction === 'in'),
    outputs: ports.filter((p) => p.direction === 'out'),
    themeColor: descriptor.theme,
    accentHex: descriptor.accentHex,
  };
}

export function nodesFromPreset(registry: ModuleRegistry, preset: RackPreset): GraphNode[] {
  return preset.modules.map((entry) => nodeFor(registry.get(entry.type), entry));
}

/** Deep copy (presets are shared constants; callers mutate positions). */
export function clonePreset(preset: RackPreset): RackPreset {
  return {
    modules: preset.modules.map((m) => ({ ...m, position: { ...m.position }, state: m.state ? { ...m.state } : undefined })),
    cables: preset.cables.map((c) => ({ ...c })),
  };
}

const cable = (id: string, fromNodeId: string, fromPortId: string, toNodeId: string, toPortId: string, color: string): PatchCable => ({
  id,
  fromNodeId,
  fromPortId,
  toNodeId,
  toPortId,
  color,
});

/** Modules only (a render config carries cables separately). */
export type RackModules = Pick<RackPreset, 'modules'>;

/**
 * The full studio: every built-in module, wired as the app historically
 * started. Render presets and the golden files use it; the module browser
 * offers it as a preset.
 */
export const FULL_RACK: RackPreset = {
  modules: [
    { type: 'clock', id: 'clock-1', position: { x: 30, y: 50 } },
    { type: 'marimba', id: 'marimba-1', position: { x: 330, y: 50 } },
    { type: 'percussion', id: 'percussion-1', position: { x: 30, y: 350 } },
    { type: 'synth', id: 'synth-1', position: { x: 330, y: 350 } },
    { type: 'delay', id: 'delay-1', position: { x: 630, y: 50 } },
    { type: 'chamber', id: 'chamber-1', position: { x: 930, y: 50 } },
    { type: 'midi', id: 'midi-1', position: { x: 1262, y: 50 } },
    { type: 'sensor', id: 'sensor-1', position: { x: 1262, y: 300 } },
    { type: 'master', id: 'master-1', position: { x: 630, y: 350 } },
  ],
  cables: [
    cable('cable-1', 'clock-1', 'clk-trig-1', 'marimba-1', 'mrm-trig-in', '#70E000'),
    cable('cable-2', 'clock-1', 'clk-trig-1', 'percussion-1', 'perc-trig-in', '#FF382E'),
    cable('cable-3', 'marimba-1', 'mrm-audio-out', 'delay-1', 'del-audio-in', '#FF9E00'),
    cable('cable-4', 'delay-1', 'del-wet-out', 'master-1', 'mst-in-l', '#FF9E00'),
    cable('cable-5', 'synth-1', 'syn-audio-out', 'master-1', 'mst-in-l', '#FF6B35'),
    cable('cable-6', 'percussion-1', 'perc-audio-out', 'master-1', 'mst-in-l', '#FF382E'),
    cable('cable-7', 'marimba-1', 'mrm-audio-out', 'master-1', 'mst-in-l', '#FF9E00'),
    cable('cable-8', 'synth-1', 'syn-audio-out', 'delay-1', 'del-audio-in', '#FF6B35'),
    cable('cable-9', 'clock-1', 'clk-trig-1', 'synth-1', 'syn-gate-in', '#70E000'),
    cable('cable-10', 'chamber-1', 'chm-trig-out', 'percussion-1', 'perc-trig-in', '#70E000'),
    cable('cable-11', 'chamber-1', 'chm-trig-out', 'marimba-1', 'mrm-trig-in', '#FF9E00'),
    cable('cable-12', 'chamber-1', 'chm-trig-out', 'synth-1', 'syn-gate-in', '#FF6B35'),
    // Keys / MIDI play the marimba out of the box (the soundboard's historical default).
    cable('cable-13', 'midi-1', 'midi-gate-out', 'marimba-1', 'mrm-trig-in', '#FF6B35'),
    // Mod wheel opens the synth filter; pitch bend bends the synth.
    cable('cable-14', 'midi-1', 'midi-mod-cv', 'synth-1', 'syn-filter-cv', '#FF6B35'),
    cable('cable-15', 'midi-1', 'midi-pitch-cv', 'synth-1', 'syn-pitch-cv', '#FF9E00'),
  ],
};

/**
 * The rack the app starts with and RESET PATCH restores: four tropical
 * modules (clock, marimba, drums, master) and the gravity chamber - a
 * complete groove that leaves room on the canvas. Add the rest from the
 * module browser or load the FULL STUDIO preset.
 */
export const DEFAULT_RACK: RackPreset = {
  modules: [
    { type: 'clock', id: 'clock-1', position: { x: 30, y: 50 } },
    { type: 'marimba', id: 'marimba-1', position: { x: 330, y: 50 } },
    { type: 'percussion', id: 'percussion-1', position: { x: 30, y: 350 } },
    { type: 'master', id: 'master-1', position: { x: 330, y: 350 } },
    { type: 'chamber', id: 'chamber-1', position: { x: 630, y: 50 } },
  ],
  cables: FULL_RACK.cables.filter((c) =>
    ['clock-1', 'marimba-1', 'percussion-1', 'master-1', 'chamber-1'].includes(c.fromNodeId) &&
    ['clock-1', 'marimba-1', 'percussion-1', 'master-1', 'chamber-1'].includes(c.toNodeId)
  ),
};

/** Named presets (RESET PATCH = 'default'; `?rack=<name>` starts with one). */
export const RACK_PRESETS: Readonly<Record<string, { title: string; description: string; preset: RackPreset }>> = {
  default: { title: 'DEFAULT RACK', description: 'Clock, marimba, drums, master bus and the gravity chamber.', preset: DEFAULT_RACK },
  full: { title: 'FULL STUDIO', description: 'Every module: adds the acid lead, the tape delay, the MIDI bridge and SENSE.', preset: FULL_RACK },
};
