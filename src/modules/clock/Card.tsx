import { Knob } from '../../components/ui/Knob.tsx';
import type { ModuleBody } from '../../components/graph/ModuleBody.ts';
import type { ClockModule } from './module.ts';

const ClockCard: ModuleBody<ClockModule> = ({ instance, refresh }) => {
  const clock = instance.clock;
  return (
    <div className="grid grid-cols-2 gap-2">
      <Knob
        label="TEMPO"
        value={clock.getBpm()}
        min={60}
        max={180}
        step={1}
        unit="BPM"
        accentColor="#70E000"
        onChange={(val) => {
          clock.setBpm(val);
          refresh();
        }}
      />
      <Knob
        label="SWING"
        value={Math.round(clock.getSwing() * 100)}
        min={0}
        max={40}
        step={1}
        unit="%"
        accentColor="#FF9E00"
        onChange={(val) => {
          clock.setSwing(val / 100);
          refresh();
        }}
      />
    </div>
  );
};

export default ClockCard;
