import { MidiBridgePanel } from '../../components/input/MidiBridgePanel.tsx';
import type { ModuleBody } from '../../components/graph/ModuleBody.ts';
import type { MidiModule } from './module.ts';

const MidiCard: ModuleBody<MidiModule> = ({ instance }) => <MidiBridgePanel keyboard={instance.keyboard} midi={instance.midi} />;

export default MidiCard;
