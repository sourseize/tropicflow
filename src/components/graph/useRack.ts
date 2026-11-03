import { useEffect, useState } from 'react';
import { AudioEngine } from '../../core/audio/AudioEngine.ts';
import type { GraphNode, PatchCable } from '../../core/graph/GraphTypes.ts';

export interface RackView {
  engine: AudioEngine;
  /** Canvas nodes in rack order, with current positions. */
  nodes: GraphNode[];
  cables: PatchCable[];
}

/**
 * The engine's rack and patch as React state: re-renders when modules are
 * added / removed / moved or cables change. The engine is the source of
 * truth; the canvas only mirrors it. Only plain data is returned: React
 * keeps a component's previous render alive for a while (fiber alternates),
 * so holding instances here would keep removed modules from being freed.
 */
export function useRack(): RackView {
  const engine = AudioEngine.getInstance();
  const [, bump] = useState(0);
  useEffect(() => {
    const unsubs = [engine.rack.subscribe(() => bump((v) => v + 1)), engine.subscribePatch(() => bump((v) => v + 1))];
    return () => unsubs.forEach((u) => u());
  }, [engine]);
  return {
    engine,
    nodes: engine.rack.nodes(),
    cables: engine.getPatch(),
  };
}
