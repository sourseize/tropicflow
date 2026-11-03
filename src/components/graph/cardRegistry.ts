/**
 * Card bodies per module type, registered on the UI side so the engine-side
 * descriptors (and the headless render harness) never touch React. A plugin
 * may instead ship its card in `descriptor.ui`; this registry is consulted
 * when it does not.
 */
import type { ModuleDescriptor } from '../../core/modules/ModuleContract.ts';

export type CardLoader = () => Promise<{ default: unknown }>;

const loaders: Map<string, CardLoader> = new Map();

export function registerModuleCard(type: string, loader: CardLoader): void {
  loaders.set(type, loader);
}

export function cardLoaderFor(descriptor: ModuleDescriptor): CardLoader | null {
  return descriptor.ui ?? loaders.get(descriptor.type) ?? null;
}

const resolved: Map<string, unknown> = new Map();

/**
 * Fetch the cards of these module types up front, so the first render of a
 * rack is complete (no "loading" placeholders, no jacks moving once bodies
 * arrive). `main.tsx` does it for the initial rack; later additions load lazily.
 */
export async function preloadCards(descriptors: ModuleDescriptor[]): Promise<void> {
  await Promise.all(
    descriptors.map(async (d) => {
      if (resolved.has(d.type)) return;
      const load = cardLoaderFor(d);
      if (load) resolved.set(d.type, (await load()).default);
    })
  );
}

/** The card component when it was preloaded, else null (use the lazy path). */
export function preloadedCard(descriptor: ModuleDescriptor): unknown | null {
  return resolved.get(descriptor.type) ?? null;
}
