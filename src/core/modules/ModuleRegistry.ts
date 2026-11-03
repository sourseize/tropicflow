/**
 * Catalogue of available module plugins. Descriptors are registered at
 * start-up (src/modules/index.ts); the heavy parts are loaded on first use
 * and cached. A new module = one folder under src/modules + one `register`.
 */
import type { ModuleDescriptor, ModuleFactory } from './ModuleContract.ts';

export class ModuleRegistry {
  private readonly descriptors: Map<string, ModuleDescriptor> = new Map();

  public register(descriptor: ModuleDescriptor): this {
    if (this.descriptors.has(descriptor.type)) {
      throw new Error(`module type "${descriptor.type}" is already registered`);
    }
    const ids = new Set<string>();
    for (const port of descriptor.ports) {
      if (ids.has(port.id)) throw new Error(`module "${descriptor.type}" declares port "${port.id}" twice`);
      ids.add(port.id);
    }
    this.descriptors.set(descriptor.type, descriptor);
    return this;
  }

  public has(type: string): boolean {
    return this.descriptors.has(type);
  }

  public get(type: string): ModuleDescriptor {
    const d = this.descriptors.get(type);
    if (!d) throw new Error(`unknown module type "${type}"`);
    return d;
  }

  /** In registration order (the order the module browser lists them). */
  public list(): ModuleDescriptor[] {
    return Array.from(this.descriptors.values());
  }

  /**
   * Load (once) the factory of a type. Built-ins may return their factory
   * synchronously (statically imported); code-split modules return a promise.
   */
  public load(type: string): Promise<ModuleFactory> {
    const ready = this.loaded.get(type);
    if (ready) return Promise.resolve(ready);
    return this.loading.get(type) ?? this.track(type, this.get(type).load());
  }

  /** Cache a descriptor's load result (sync or pending). */
  private track(type: string, result: ModuleFactory | Promise<ModuleFactory>): Promise<ModuleFactory> {
    if (!(result instanceof Promise)) {
      this.loaded.set(type, result);
      return Promise.resolve(result);
    }
    const p = result.then(
      (factory) => {
        this.loaded.set(type, factory);
        this.loading.delete(type);
        return factory;
      },
      (err) => {
        this.loading.delete(type); // allow a retry after a failed import
        throw err;
      }
    );
    this.loading.set(type, p);
    return p;
  }

  /** True once the factory is in memory. */
  public isLoaded(type: string): boolean {
    return this.loaded.has(type);
  }

  /**
   * The factory when it is already in memory, else `null`. The realtime engine
   * is built synchronously, so built-ins resolve here right after `loadAll()`
   * or, for synchronous descriptors, on first call.
   */
  public peek(type: string): ModuleFactory | null {
    const ready = this.loaded.get(type);
    if (ready) return ready;
    if (this.loading.has(type)) return null;
    const result = this.get(type).load();
    void this.track(type, result).catch(() => {});
    return result instanceof Promise ? null : result;
  }

  /** Load every registered type up front. */
  public async loadAll(): Promise<void> {
    await Promise.all(this.list().map((d) => this.load(d.type)));
  }

  private readonly loaded: Map<string, ModuleFactory> = new Map();
  private readonly loading: Map<string, Promise<ModuleFactory>> = new Map();
}

/** The application-wide registry (built-ins are registered by src/modules/index.ts). */
export const moduleRegistry = new ModuleRegistry();
