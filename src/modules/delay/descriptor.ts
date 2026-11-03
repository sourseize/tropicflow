import type { ModuleDescriptor } from '../../core/modules/ModuleContract.ts';

export const delayDescriptor: ModuleDescriptor = {
  type: 'delay',
  title: 'TROPICAL TAPE DELAY',
  description: 'Tape-style delay with damped feedback; delay time modulated by CV.',
  theme: 'mango',
  accentHex: '#FF9E00',
  cardWidthPx: 288,
  ports: [
    { id: 'del-audio-in', name: 'AUDIO IN', type: 'audio-in', color: '#FF9E00' },
    { id: 'del-time-cv', name: 'TIME CV', type: 'cv-in', color: '#70E000', cvKind: 'time' },
    { id: 'del-wet-out', name: 'WET OUT', type: 'audio-out', color: '#FF9E00' },
  ],
  load: () => import('./module.ts').then((m) => m.delayFactory),
};
