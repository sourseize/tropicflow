import { Knob } from '../../components/ui/Knob.tsx';
import type { ModuleBody } from '../../components/graph/ModuleBody.ts';
import type { PercussionModule } from './module.ts';

const PercussionCard: ModuleBody<PercussionModule> = ({ instance, refresh }) => {
  const drums = instance.drums;
  return (
    <div className="grid grid-cols-3 gap-1">
      <Knob
        label="KICK TUNE"
        value={drums.getParams().kickTune}
        min={80}
        max={220}
        step={2}
        unit="Hz"
        accentColor="#FF382E"
        onChange={(val) => {
          drums.updateParam('kickTune', val);
          refresh();
        }}
      />
      <Knob
        label="SNARE SNAP"
        value={Math.round(drums.getParams().snareSnap * 100)}
        min={10}
        max={100}
        step={5}
        unit="%"
        accentColor="#FF6B35"
        onChange={(val) => {
          drums.updateParam('snareSnap', val / 100);
          refresh();
        }}
      />
      <Knob
        label="HAT SIZZLE"
        value={Number(drums.getParams().hihatDecay.toFixed(2))}
        min={0.03}
        max={0.25}
        step={0.01}
        unit="s"
        accentColor="#70E000"
        onChange={(val) => {
          drums.updateParam('hihatDecay', val);
          refresh();
        }}
      />
    </div>
  );
};

export default PercussionCard;
