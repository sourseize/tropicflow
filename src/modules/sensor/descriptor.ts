import type { ModuleDescriptor } from '../../core/modules/ModuleContract.ts';

export const sensorDescriptor: ModuleDescriptor = {
  type: 'sensor',
  title: 'SENSE',
  description: 'Microphone or virtual voice tracked in realtime: pitch CV, level CV and onset triggers.',
  theme: 'lime',
  accentHex: '#70E000',
  cardWidthPx: 224,
  ports: [
    { id: 'sns-pitch-cv', name: 'PITCH CV', type: 'cv-out', color: '#FF9E00', cvKind: 'pitch' },
    { id: 'sns-level-cv', name: 'LEVEL CV', type: 'cv-out', color: '#FF6B35', cvKind: 'control' },
    { id: 'sns-onset-out', name: 'ONSET TRIG', type: 'trigger-out', color: '#70E000', noteSource: 'sensor' },
  ],
  load: () => import('./module.ts').then((m) => m.sensorFactory),
};
