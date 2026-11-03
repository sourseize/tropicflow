import { Knob } from '../../components/ui/Knob.tsx';
import type { ModuleBody } from '../../components/graph/ModuleBody.ts';
import type { MasterModule } from './module.ts';

const MasterCard: ModuleBody<MasterModule> = ({ instance, refresh }) => {
  const bus = instance.bus;
  return (
    <div className="grid grid-cols-2 gap-2">
      <Knob
        label="MASTER VOL"
        value={Math.round(bus.getVolume() * 100)}
        min={0}
        max={100}
        step={1}
        unit="%"
        accentColor="#70E000"
        onChange={(val) => {
          bus.setVolume(val / 100);
          refresh();
        }}
      />
      <div className="flex flex-col justify-center items-center p-2 bg-jungle-950 rounded-lg border border-jungle-800">
        <span className="text-[10px] font-mono text-lime-400 font-bold">ANALOG LIMITER</span>
        <span className="text-[9px] font-mono text-cream-200/50 mt-0.5">ACTIVE (-3dB)</span>
      </div>
    </div>
  );
};

export default MasterCard;
