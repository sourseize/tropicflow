import type { ModuleDescriptor } from '../../core/modules/ModuleContract.ts';

export const synthDescriptor: ModuleDescriptor = {
  type: 'synth',
  title: 'PAPAYA ACID LEAD',
  description: 'Dual-oscillator resonant lead / bass with held notes, pitch and cutoff CV.',
  theme: 'papaya',
  accentHex: '#FF6B35',
  cardWidthPx: 288,
  ports: [
    { id: 'syn-gate-in', name: 'GATE IN', type: 'trigger-in', color: '#70E000' },
    { id: 'syn-pitch-cv', name: 'PITCH CV', type: 'cv-in', color: '#FF9E00', cvKind: 'pitch' },
    { id: 'syn-filter-cv', name: 'CUTOFF CV', type: 'cv-in', color: '#FF6B35', cvKind: 'cutoff' },
    { id: 'syn-audio-out', name: 'AUDIO OUT', type: 'audio-out', color: '#FF6B35' },
  ],
  load: () => import('./module.ts').then((m) => m.synthFactory),
};
