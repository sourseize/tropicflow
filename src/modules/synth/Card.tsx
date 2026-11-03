import { Knob } from '../../components/ui/Knob.tsx';
import type { ModuleBody } from '../../components/graph/ModuleBody.ts';
import type { SynthModule } from './module.ts';

const SynthCard: ModuleBody<SynthModule> = ({ instance, refresh }) => {
  const voice = instance.voice;
  return (
    <div className="grid grid-cols-3 gap-1">
      <Knob
        label="CUTOFF"
        value={voice.getParams().filterCutoff}
        min={200}
        max={6000}
        step={50}
        unit="Hz"
        accentColor="#FF6B35"
        onChange={(val) => {
          voice.updateParam('filterCutoff', val);
          refresh();
        }}
      />
      <Knob
        label="RES"
        value={Number(voice.getParams().filterResonance.toFixed(1))}
        min={0.5}
        max={15}
        step={0.5}
        accentColor="#FF9E00"
        onChange={(val) => {
          voice.updateParam('filterResonance', val);
          refresh();
        }}
      />
      <Knob
        label="DETUNE"
        value={voice.getParams().detune}
        min={0}
        max={25}
        step={1}
        unit="ct"
        accentColor="#FF6B35"
        onChange={(val) => {
          voice.updateParam('detune', val);
          refresh();
        }}
      />
    </div>
  );
};

export default SynthCard;
