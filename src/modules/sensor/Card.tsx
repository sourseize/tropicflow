import { SensePanel } from '../../components/input/SensePanel.tsx';
import type { ModuleBody } from '../../components/graph/ModuleBody.ts';
import type { SensorModule } from './module.ts';

const SensorCard: ModuleBody<SensorModule> = ({ instance }) => <SensePanel sensor={instance.sensor} />;

export default SensorCard;
