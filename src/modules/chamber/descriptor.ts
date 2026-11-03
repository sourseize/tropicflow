import type { ModuleDescriptor } from '../../core/modules/ModuleContract.ts';

export const chamberDescriptor: ModuleDescriptor = {
  type: 'chamber',
  title: 'GRAVITY CHAMBER',
  description: 'Deterministic 2-D physics box: every ball collision is a trigger, mapped by surface.',
  theme: 'lime',
  accentHex: '#70E000',
  cardWidthPx: 320,
  ports: [{ id: 'chm-trig-out', name: 'HIT TRIG', type: 'trigger-out', color: '#70E000', noteSource: 'chamber' }],
  load: () => import('./module.ts').then((m) => m.chamberFactory),
};
