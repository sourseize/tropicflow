import type { ModuleDescriptor } from '../../core/modules/ModuleContract.ts';

export const masterDescriptor: ModuleDescriptor = {
  type: 'master',
  title: 'JUNGLE MASTER BUS',
  description: 'Sum, compressor and analyser feeding the speakers (and the take recorder).',
  theme: 'lime',
  accentHex: '#70E000',
  cardWidthPx: 288,
  ports: [
    { id: 'mst-in-l', name: 'SUM L/R', type: 'audio-in', color: '#FF9E00' },
    { id: 'mst-monitor', name: 'MONITOR', type: 'audio-out', color: '#70E000' },
  ],
  load: () => import('./module.ts').then((m) => m.masterFactory),
};
