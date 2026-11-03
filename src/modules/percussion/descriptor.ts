import type { ModuleDescriptor } from '../../core/modules/ModuleContract.ts';

export const percussionDescriptor: ModuleDescriptor = {
  type: 'percussion',
  title: 'TOMATO DRUMS',
  description: 'Analog-style kick, snare and hi-hat from a seeded noise source.',
  theme: 'tomato',
  accentHex: '#FF382E',
  cardWidthPx: 288,
  ports: [
    { id: 'perc-trig-in', name: 'TRIG IN', type: 'trigger-in', color: '#70E000' },
    { id: 'perc-audio-out', name: 'DRUM MIX', type: 'audio-out', color: '#FF382E' },
  ],
  load: () => import('./module.ts').then((m) => m.percussionFactory),
};
