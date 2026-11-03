import { Knob } from '../../components/ui/Knob.tsx';
import type { ModuleBody } from '../../components/graph/ModuleBody.ts';
import type { DelayModule } from './module.ts';

const DelayCard: ModuleBody<DelayModule> = ({ instance, refresh }) => {
  const effect = instance.effect;
  return (
    <div className="grid grid-cols-3 gap-1">
      <Knob
        label="TIME"
        value={Math.round(effect.getParams().time * 1000)}
        min={60}
        max={800}
        step={10}
        unit="ms"
        accentColor="#FF9E00"
        onChange={(val) => {
          effect.setDelayTime(val / 1000);
          refresh();
        }}
      />
      <Knob
        label="FEEDBACK"
        value={Math.round(effect.getParams().feedback * 100)}
        min={0}
        max={80}
        step={1}
        unit="%"
        accentColor="#FF9E00"
        onChange={(val) => {
          effect.setFeedback(val / 100);
          refresh();
        }}
      />
      <Knob
        label="WET MIX"
        value={Math.round(effect.getParams().mix * 100)}
        min={0}
        max={100}
        step={2}
        unit="%"
        accentColor="#FF9E00"
        onChange={(val) => {
          effect.setMix(val / 100);
          refresh();
        }}
      />
    </div>
  );
};

export default DelayCard;
