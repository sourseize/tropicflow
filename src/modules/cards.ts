/**
 * Card bodies of the built-in modules (code-split, fetched when a module of
 * that type is first shown). Imported by the app, not by the engine.
 */
import { registerModuleCard } from '../components/graph/cardRegistry.ts';

registerModuleCard('clock', () => import('./clock/Card.tsx'));
registerModuleCard('marimba', () => import('./marimba/Card.tsx'));
registerModuleCard('percussion', () => import('./percussion/Card.tsx'));
registerModuleCard('synth', () => import('./synth/Card.tsx'));
registerModuleCard('delay', () => import('./delay/Card.tsx'));
registerModuleCard('chamber', () => import('./chamber/Card.tsx'));
registerModuleCard('midi', () => import('./midi/Card.tsx'));
registerModuleCard('sensor', () => import('./sensor/Card.tsx'));
registerModuleCard('master', () => import('./master/Card.tsx'));
