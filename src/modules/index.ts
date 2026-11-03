/**
 * Built-in module plugins: descriptors only. Each descriptor's `load` / `ui`
 * is a dynamic import, so a module's engine part and card are separate
 * chunks fetched the first time the module is put in the rack (the default
 * rack loads all nine at boot; `?rack=empty` loads none).
 *
 * A new module = one folder under src/modules + one entry here.
 */
import type { ModuleDescriptor } from '../core/modules/ModuleContract.ts';
import { type ModuleRegistry, moduleRegistry } from '../core/modules/ModuleRegistry.ts';
import { clockDescriptor } from './clock/descriptor.ts';
import { marimbaDescriptor } from './marimba/descriptor.ts';
import { percussionDescriptor } from './percussion/descriptor.ts';
import { synthDescriptor } from './synth/descriptor.ts';
import { delayDescriptor } from './delay/descriptor.ts';
import { chamberDescriptor } from './chamber/descriptor.ts';
import { midiDescriptor } from './midi/descriptor.ts';
import { sensorDescriptor } from './sensor/descriptor.ts';
import { masterDescriptor } from './master/descriptor.ts';

/** In the order the module browser lists them. */
export const BUILTIN_MODULES: ReadonlyArray<ModuleDescriptor> = [
  clockDescriptor,
  marimbaDescriptor,
  percussionDescriptor,
  synthDescriptor,
  delayDescriptor,
  chamberDescriptor,
  midiDescriptor,
  sensorDescriptor,
  masterDescriptor,
];

/** Register the built-ins on a registry. Idempotent per registry. */
export function registerBuiltins(registry: ModuleRegistry = moduleRegistry): ModuleRegistry {
  for (const descriptor of BUILTIN_MODULES) {
    if (!registry.has(descriptor.type)) registry.register(descriptor);
  }
  return registry;
}

registerBuiltins();
