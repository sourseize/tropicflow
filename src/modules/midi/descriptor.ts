import type { ModuleDescriptor } from '../../core/modules/ModuleContract.ts';

export const midiDescriptor: ModuleDescriptor = {
  type: 'midi',
  title: 'MIDI BRIDGE',
  description: 'Web MIDI keyboard or the computer keys as a gate source, with pitch-bend and mod-wheel CV.',
  theme: 'papaya',
  accentHex: '#FF6B35',
  cardWidthPx: 224,
  ports: [
    { id: 'midi-gate-out', name: 'GATE OUT', type: 'trigger-out', color: '#70E000', noteSource: 'midi' },
    { id: 'midi-pitch-cv', name: 'PITCH CV', type: 'cv-out', color: '#FF9E00', cvKind: 'pitch' },
    { id: 'midi-mod-cv', name: 'MOD CV', type: 'cv-out', color: '#FF6B35', cvKind: 'control' },
  ],
  load: () => import('./module.ts').then((m) => m.midiFactory),
};
