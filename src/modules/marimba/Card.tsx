import { Knob } from '../../components/ui/Knob.tsx';
import type { ModuleBody } from '../../components/graph/ModuleBody.ts';
import type { MarimbaModule } from './module.ts';

const MarimbaCard: ModuleBody<MarimbaModule> = ({ instance, refresh }) => {
  const model = instance.model;
  return (
    <div className="grid grid-cols-3 gap-1">
      <Knob
        label="MALLET"
        value={Number(model.getParams().brightness.toFixed(1))}
        min={1}
        max={10}
        step={0.1}
        accentColor="#FF9E00"
        onChange={(val) => {
          model.updateParam('brightness', val);
          refresh();
        }}
      />
      <Knob
        label="RING"
        value={Number(model.getParams().decay.toFixed(2))}
        min={0.1}
        max={1.8}
        step={0.05}
        unit="s"
        accentColor="#FF9E00"
        onChange={(val) => {
          model.updateParam('decay', val);
          refresh();
        }}
      />
      <Knob
        label="VOL"
        value={Math.round(model.getParams().volume * 100)}
        min={0}
        max={100}
        step={1}
        unit="%"
        accentColor="#FF9E00"
        onChange={(val) => {
          model.updateParam('volume', val / 100);
          refresh();
        }}
      />
    </div>
  );
};

export default MarimbaCard;
