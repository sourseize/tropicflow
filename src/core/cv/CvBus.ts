/**
 * Control-voltage routing: makes the CV jacks functional.
 *
 * Sources publish plain numbers; cables of the `cv` family (PatchRouter)
 * decide which targets receive them; a target's value is the sum of its
 * sources after a kind-aware scaling. Control-rate and pure: the engine
 * applies target values to AudioParams with `setTargetAtTime` at the
 * event's time, so the same events modulate identically in realtime and
 * in offline renders.
 *
 * Kinds:
 *   source 'pitch'   semitones (bipolar), e.g. pitch bend x range, tracked pitch
 *   source 'control' 0..1, e.g. mod wheel, level, swing
 *   target 'pitch'   semitones added to the notes of the module
 *   target 'cutoff'  octaves added to the synth's filter cutoff
 *   target 'time'    octaves added to the delay time
 */
import type { ResolvedLink } from '../graph/PatchRouter.ts';
import type { CvSourceKind, CvTargetKind, GraphNode } from '../graph/GraphTypes.ts';

export type { CvSourceKind, CvTargetKind };

/** Which jacks are CV sources / targets and how each is interpreted (declared by the modules). */
export interface CvPortKinds {
  sources: Record<string, CvSourceKind>;
  targets: Record<string, CvTargetKind>;
}

/** Collect the CV kinds declared on a set of canvas nodes. */
export function cvKinds(nodes: GraphNode[]): CvPortKinds {
  const kinds: CvPortKinds = { sources: {}, targets: {} };
  for (const node of nodes) {
    for (const p of node.outputs) if (p.type === 'cv-out' && p.cvKind) kinds.sources[p.id] = p.cvKind as CvSourceKind;
    for (const p of node.inputs) if (p.type === 'cv-in' && p.cvKind) kinds.targets[p.id] = p.cvKind as CvTargetKind;
  }
  return kinds;
}

/** Full-scale control (1.0) into a pitch target = one octave. */
export const CONTROL_TO_SEMITONES = 12;
/** Full-scale control into the cutoff = three octaves up. */
export const CONTROL_TO_CUTOFF_OCTAVES = 3;
/** Full-scale control into the delay time = one octave (double). */
export const CONTROL_TO_TIME_OCTAVES = 1;

/** Scale a source value for a target. */
export function scaleCv(source: CvSourceKind, target: CvTargetKind, value: number): number {
  if (source === 'pitch') {
    // semitones -> semitones, or semitones -> octaves
    return target === 'pitch' ? value : value / 12;
  }
  switch (target) {
    case 'pitch':
      return value * CONTROL_TO_SEMITONES;
    case 'cutoff':
      return value * CONTROL_TO_CUTOFF_OCTAVES;
    case 'time':
      return value * CONTROL_TO_TIME_OCTAVES;
  }
}

export interface CvChange {
  targetPortId: string;
  kind: CvTargetKind;
  value: number;
}

export class CvBus {
  private kinds: CvPortKinds;
  private readonly sources: Map<string, number> = new Map();
  /** target port -> source ports patched into it */
  private links: Map<string, Set<string>> = new Map();
  private readonly targetValues: Map<string, number> = new Map();

  constructor(kinds: CvPortKinds = { sources: {}, targets: {} }) {
    this.kinds = kinds;
  }

  /**
   * Replace the routing (from PatchRouter.resolvePatch(...).cv) and, when
   * given, the jack kinds (modules were added / removed). Returns every
   * target whose value changed, including targets that disappeared (reset to 0).
   */
  public setLinks(links: ResolvedLink[], kinds?: CvPortKinds): CvChange[] {
    const previousTargets = Object.keys(this.kinds.targets);
    if (kinds) this.kinds = kinds;
    this.links = new Map();
    for (const l of links) {
      if (!(l.fromPortId in this.kinds.sources) || !(l.toPortId in this.kinds.targets)) continue;
      if (!this.links.has(l.toPortId)) this.links.set(l.toPortId, new Set());
      this.links.get(l.toPortId)!.add(l.fromPortId);
    }
    const changes = this.recompute(Object.keys(this.kinds.targets));
    for (const gone of previousTargets) {
      if (gone in this.kinds.targets) continue;
      if ((this.targetValues.get(gone) ?? 0) !== 0) changes.push({ targetPortId: gone, kind: 'pitch', value: 0 });
      this.targetValues.delete(gone);
    }
    return changes;
  }

  /** Publish a source value. Returns the targets whose value changed. Unknown sources are ignored. */
  public setSource(portId: string, value: number): CvChange[] {
    if (!(portId in this.kinds.sources)) return [];
    if (this.sources.get(portId) === value) return [];
    this.sources.set(portId, value);
    const targets: string[] = [];
    for (const [target, srcs] of this.links) if (srcs.has(portId)) targets.push(target);
    return this.recompute(targets);
  }

  public getSource(portId: string): number {
    return this.sources.get(portId) ?? 0;
  }

  /** Current value of a target (0 when nothing is patched into it). */
  public targetValue(portId: string): number {
    return this.targetValues.get(portId) ?? 0;
  }

  /** Source ports patched into a target. */
  public sourcesOf(targetPortId: string): string[] {
    return Array.from(this.links.get(targetPortId) ?? []);
  }

  private compute(target: string): number {
    const kind = this.kinds.targets[target];
    let sum = 0;
    for (const src of this.links.get(target) ?? []) sum += scaleCv(this.kinds.sources[src], kind, this.sources.get(src) ?? 0);
    return sum;
  }

  private recompute(targets: string[]): CvChange[] {
    const changes: CvChange[] = [];
    for (const target of targets) {
      const value = this.compute(target);
      if ((this.targetValues.get(target) ?? 0) === value) continue;
      this.targetValues.set(target, value);
      changes.push({ targetPortId: target, kind: this.kinds.targets[target], value });
    }
    return changes;
  }
}
