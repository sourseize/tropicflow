/**
 * The live rack: module instances by id, each with its own resource ledger.
 * Owns the canvas nodes that correspond to the instances. Loading a preset
 * is synchronous when every factory is already in memory (the realtime
 * engine is constructed synchronously); `add` loads on demand.
 *
 * In phase 0 the engine still routes audio / triggers / CV by hand from the
 * instances it pulls out of the rack, so `editable` is false: add / remove
 * work mechanically but the engine would not hear a module added later.
 * Phase 1 makes routing generic, phase 2 flips `editable`.
 */
import type { GraphNode } from '../graph/GraphTypes.ts';
import type { ModuleFactory, ModuleHost, ModuleInstance, RackInspection } from './ModuleContract.ts';
import type { ModuleRegistry } from './ModuleRegistry.ts';
import { type RackModuleEntry, type RackPreset, nodeFor } from './RackPreset.ts';
import { EMPTY_COUNTS, type ResourceLedger, addCounts } from './ResourceLedger.ts';

export interface RackSlot {
  instance: ModuleInstance;
  ledger: ResourceLedger;
  node: GraphNode;
}

/** Builds the host for one instance; the rack keeps the ledger to inspect and release it. */
export type HostFactory = (id: string, type: string) => { host: ModuleHost; ledger: ResourceLedger };

/**
 * 'modules': instances were added / removed (re-resolve the patch);
 * 'reset': a whole preset was loaded (views drop per-card state such as minimised);
 * 'layout': a card moved.
 */
export type RackChange = 'modules' | 'reset' | 'layout';
export type RackListener = (change: RackChange) => void;

export class ModuleRack {
  private readonly slots: Map<string, RackSlot> = new Map();
  private readonly listeners: Set<RackListener> = new Set();
  /** While the transport runs, modules added later join it at the same start time. */
  private transport: { startTime: number } | null = null;

  public readonly registry: ModuleRegistry;
  public readonly editable: boolean;
  private readonly makeHost: HostFactory;

  constructor(registry: ModuleRegistry, makeHost: HostFactory, editable: boolean = false) {
    this.registry = registry;
    this.makeHost = makeHost;
    this.editable = editable;
  }

  // -------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------

  /**
   * Instantiate a preset's modules (in order). Every factory must already be
   * in memory (`registry.peek`); use `loadAsync` otherwise.
   */
  public load(preset: RackPreset): void {
    this.clear();
    for (const entry of preset.modules) this.instantiate(entry, this.requireFactory(entry.type));
    this.notify('reset');
  }

  public async loadAsync(preset: RackPreset): Promise<void> {
    this.clear();
    // Fetch every module's code first (in parallel), then instantiate in preset order.
    const factories = await Promise.all(preset.modules.map((entry) => this.registry.load(entry.type)));
    preset.modules.forEach((entry, i) => this.instantiate(entry, factories[i]));
    this.notify('reset');
  }

  /** Add one module of `type` (loads its code when needed). */
  public async add(type: string, entry: Partial<Omit<RackModuleEntry, 'type'>> = {}): Promise<ModuleInstance> {
    const factory = await this.registry.load(type);
    const slot = this.instantiate(
      { type, id: entry.id ?? this.nextId(type), position: entry.position ?? { x: 30, y: 50 }, state: entry.state },
      factory
    );
    this.notify();
    return slot.instance;
  }

  public remove(id: string): boolean {
    const slot = this.slots.get(id);
    if (!slot) return false;
    this.destroy(slot);
    this.slots.delete(id);
    this.notify();
    return true;
  }

  public clear(): void {
    if (this.slots.size === 0) return;
    for (const slot of this.slots.values()) this.destroy(slot);
    this.slots.clear();
    this.notify();
  }

  private instantiate(entry: RackModuleEntry, factory: ModuleFactory): RackSlot {
    if (this.slots.has(entry.id)) throw new Error(`module id "${entry.id}" is already in the rack`);
    const descriptor = this.registry.get(entry.type);
    const { host, ledger } = this.makeHost(entry.id, entry.type);
    const instance = factory.create(host, entry.id, entry.state);
    const slot: RackSlot = { instance, ledger, node: nodeFor(descriptor, entry) };
    this.slots.set(entry.id, slot);
    if (this.transport) instance.onTransportStart?.(this.transport.startTime);
    return slot;
  }

  private destroy(slot: RackSlot): void {
    try {
      slot.instance.dispose();
    } finally {
      slot.ledger.release();
    }
  }

  private requireFactory(type: string) {
    const factory = this.registry.peek(type);
    if (!factory) throw new Error(`module "${type}" is not loaded yet; use loadAsync`);
    return factory;
  }

  /** Lowest free `<type>-N` (so a re-added module gets the canonical jack ids back). */
  private nextId(type: string): string {
    for (let n = 1; ; n++) {
      const id = `${type}-${n}`;
      if (!this.slots.has(id)) return id;
    }
  }

  // -------------------------------------------------------------------
  // Access
  // -------------------------------------------------------------------

  public get(id: string): ModuleInstance | null {
    return this.slots.get(id)?.instance ?? null;
  }

  /** The instance with this id, typed by the caller (throws when absent). */
  public require<T extends ModuleInstance>(id: string): T {
    const instance = this.get(id);
    if (!instance) throw new Error(`module "${id}" is not in the rack`);
    return instance as T;
  }

  /** First instance of a type, if any. */
  public findByType<T extends ModuleInstance>(type: string): T | null {
    for (const slot of this.slots.values()) if (slot.instance.descriptor.type === type) return slot.instance as T;
    return null;
  }

  public has(id: string): boolean {
    return this.slots.has(id);
  }

  public list(): ModuleInstance[] {
    return Array.from(this.slots.values(), (s) => s.instance);
  }

  /** The canvas nodes, in rack order (positions are the rack's). */
  public nodes(): GraphNode[] {
    return Array.from(this.slots.values(), (s) => s.node);
  }

  public moveNode(id: string, position: { x: number; y: number }): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    slot.node = { ...slot.node, position: { ...position } };
    this.notify('layout');
  }

  /** Serialise the rack (module list + states; cables are the engine's). */
  public toPreset(cables: RackPreset['cables']): RackPreset {
    return {
      modules: Array.from(this.slots.values(), (s) => ({
        type: s.instance.descriptor.type,
        id: s.instance.id,
        position: { ...s.node.position },
        state: s.instance.getState?.(),
      })),
      cables: cables.map((c) => ({ ...c })),
    };
  }

  /** Per-module resource counts (what the profiler reads). */
  public inspect(): RackInspection {
    const modules = Array.from(this.slots.values(), (s) => ({
      id: s.instance.id,
      type: s.instance.descriptor.type,
      ...s.ledger.counts(),
    }));
    return {
      modules,
      total: modules.reduce((acc, m) => addCounts(acc, m), { ...EMPTY_COUNTS }),
      editable: this.editable,
    };
  }

  // -------------------------------------------------------------------
  // Transport fan-out
  // -------------------------------------------------------------------

  public transportStart(startTime: number): void {
    this.transport = { startTime };
    for (const slot of this.slots.values()) slot.instance.onTransportStart?.(startTime);
  }

  public transportStop(): void {
    this.transport = null;
    for (const slot of this.slots.values()) slot.instance.onTransportStop?.();
  }

  public isTransportRunning(): boolean {
    return this.transport !== null;
  }

  // -------------------------------------------------------------------
  // Change notification (the canvas re-reads nodes)
  // -------------------------------------------------------------------

  public subscribe(listener: RackListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(change: RackChange = 'modules'): void {
    for (const l of Array.from(this.listeners)) l(change);
  }
}
