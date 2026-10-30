import type { GraphNode, ModulePort, PatchCable, PortType } from './GraphTypes.ts';

export type PortFamily = 'audio' | 'trigger' | 'cv';

export function portFamily(type: PortType): PortFamily {
  if (type === 'audio-in' || type === 'audio-out') return 'audio';
  if (type === 'trigger-in' || type === 'trigger-out') return 'trigger';
  return 'cv';
}

/** A cable is valid when it runs from an output jack to an input jack of the same family. */
export function canConnect(from: ModulePort, to: ModulePort): boolean {
  if (from.direction !== 'out' || to.direction !== 'in') return false;
  return portFamily(from.type) === portFamily(to.type);
}

export function findPort(nodes: GraphNode[], portId: string): { node: GraphNode; port: ModulePort } | null {
  for (const node of nodes) {
    for (const port of node.inputs) if (port.id === portId) return { node, port };
    for (const port of node.outputs) if (port.id === portId) return { node, port };
  }
  return null;
}

export interface ResolvedLink {
  cableId: string;
  fromNodeId: string;
  fromPortId: string;
  toNodeId: string;
  toPortId: string;
}

export interface ResolvedPatch {
  audio: ResolvedLink[];
  trigger: ResolvedLink[];
  cv: ResolvedLink[];
  /** Cables that reference unknown ports or violate the direction/family rules. */
  invalid: PatchCable[];
}

/** Classify cables by family and drop anything that isn't a legal connection. */
export function resolvePatch(cables: PatchCable[], nodes: GraphNode[]): ResolvedPatch {
  const result: ResolvedPatch = { audio: [], trigger: [], cv: [], invalid: [] };
  const seen = new Set<string>();

  for (const cable of cables) {
    const from = findPort(nodes, cable.fromPortId);
    const to = findPort(nodes, cable.toPortId);
    if (!from || !to || !canConnect(from.port, to.port)) {
      result.invalid.push(cable);
      continue;
    }
    const key = `${cable.fromPortId}->${cable.toPortId}`;
    if (seen.has(key)) continue; // duplicate cable: same connection, no extra effect
    seen.add(key);

    const link: ResolvedLink = {
      cableId: cable.id,
      fromNodeId: from.node.id,
      fromPortId: cable.fromPortId,
      toNodeId: to.node.id,
      toPortId: cable.toPortId,
    };
    result[portFamily(from.port.type)].push(link);
  }
  return result;
}

/**
 * Build a cable between two ports, normalising direction so that the caller
 * can drag from either end. Returns null when the pair is not connectable.
 */
export function makeCable(
  nodes: GraphNode[],
  aPortId: string,
  bPortId: string,
  id: string,
  color: string
): PatchCable | null {
  const a = findPort(nodes, aPortId);
  const b = findPort(nodes, bPortId);
  if (!a || !b) return null;

  if (canConnect(a.port, b.port)) {
    return { id, fromNodeId: a.node.id, fromPortId: aPortId, toNodeId: b.node.id, toPortId: bPortId, color };
  }
  if (canConnect(b.port, a.port)) {
    return { id, fromNodeId: b.node.id, fromPortId: bPortId, toNodeId: a.node.id, toPortId: aPortId, color };
  }
  return null;
}
