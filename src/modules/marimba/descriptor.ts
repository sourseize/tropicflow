import type { ModuleDescriptor } from '../../core/modules/ModuleContract.ts';

export const marimbaDescriptor: ModuleDescriptor = {
  type: 'marimba',
  title: 'MANGO MARIMBA',
  description: 'FM marimba: acoustic-modelled strikes with brightness, decay and body tone.',
  theme: 'mango',
  accentHex: '#FF9E00',
  cardWidthPx: 288,
  ports: [
    { id: 'mrm-trig-in', name: 'TRIG IN', type: 'trigger-in', color: '#70E000' },
    { id: 'mrm-cv-in', name: 'PITCH CV', type: 'cv-in', color: '#FF9E00', cvKind: 'pitch' },
    { id: 'mrm-audio-out', name: 'AUDIO OUT', type: 'audio-out', color: '#FF9E00' },
  ],
  load: () => import('./module.ts').then((m) => m.marimbaFactory),
};
