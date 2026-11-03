import type { ModuleDescriptor } from '../../core/modules/ModuleContract.ts';

export const CLOCK_TRIG_OUT = 'clk-trig-1';
export const CLOCK_SWING_CV = 'clk-swing-1';

export const clockDescriptor: ModuleDescriptor = {
  type: 'clock',
  title: 'TROPIC CLOCK',
  description: 'Sample-accurate lookahead clock: 16-step trigger source with swing, also as a CV.',
  theme: 'lime',
  accentHex: '#70E000',
  cardWidthPx: 288,
  ports: [
    { id: CLOCK_TRIG_OUT, name: 'TRIG OUT', type: 'trigger-out', color: '#70E000', noteSource: 'sequencer' },
    { id: CLOCK_SWING_CV, name: 'SWING CV', type: 'cv-out', color: '#FF9E00', cvKind: 'control' },
  ],
  load: () => import('./module.ts').then((m) => m.clockFactory),
};
