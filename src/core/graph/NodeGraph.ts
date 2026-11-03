/**
 * The full studio canvas, derived from the FULL_RACK preset: the modules'
 * jacks come from their plugin descriptors (src/modules), positions and
 * cables from core/modules/RackPreset. Kept as the two constants the render
 * presets and the routing tests always imported (every jack exists here).
 */
import type { GraphNode, PatchCable } from './GraphTypes.ts';
import { moduleRegistry } from '../modules/ModuleRegistry.ts';
import { FULL_RACK, nodesFromPreset } from '../modules/RackPreset.ts';
import '../../modules/index.ts';

export const INITIAL_NODES: GraphNode[] = nodesFromPreset(moduleRegistry, FULL_RACK);

export const INITIAL_CABLES: PatchCable[] = FULL_RACK.cables.map((c) => ({ ...c }));
