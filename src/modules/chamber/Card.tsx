import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, Download, Sliders, Trash2, Upload } from 'lucide-react';
import { Knob } from '../../components/ui/Knob.tsx';
import { GravityChamberView } from '../../components/chamber/GravityChamberView.tsx';
import { ChamberMappingPanel } from '../../components/chamber/ChamberMappingPanel.tsx';
import type { ModuleBody } from '../../components/graph/ModuleBody.ts';
import { EventBus } from '../../core/events/EventBus.ts';
import type { ChamberConfig } from '../../core/physics/ChamberEngine.ts';
import type { ChamberModule } from './module.ts';

function downloadJson(data: unknown, filename: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const ChamberCard: ModuleBody<ChamberModule> = ({ instance, refresh }) => {
  const chamber = instance.engine;
  const [showMapping, setShowMapping] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Ball count / geometry changes come from the chamber engine, not props.
  useEffect(() => EventBus.getInstance().subscribe('CHAMBER_CHANGED', refresh), [refresh]);

  const importChamber = (file: File) => {
    file.text().then((text) => {
      try {
        const parsed = JSON.parse(text) as Partial<ChamberConfig> & { chamber?: Partial<ChamberConfig> };
        // Accept a bare chamber config or a bounce score file that contains one.
        const cfg = parsed.chamber ?? (parsed as { config?: { chamber?: Partial<ChamberConfig> } }).config?.chamber ?? parsed;
        chamber.loadConfig(cfg as Partial<ChamberConfig>);
        refresh();
      } catch (err) {
        console.error('[chamber] import failed', err);
      }
    });
  };

  const balls = chamber.getBalls().length;

  return (
    <div className="flex flex-col gap-2">
      <GravityChamberView chamber={chamber} />
      <div className="grid grid-cols-4 gap-1">
        <Knob
          label="GRAVITY"
          value={Number(chamber.physics.getConfig().gravity.y.toFixed(1))}
          min={0.5}
          max={8}
          step={0.1}
          accentColor="#70E000"
          onChange={(val) => {
            chamber.updatePhysics({ gravity: { x: 0, y: val } });
            refresh();
          }}
        />
        <Knob
          label="BOUNCE"
          value={Math.round(chamber.physics.getConfig().restitution * 100)}
          min={20}
          max={98}
          step={1}
          unit="%"
          accentColor="#FF9E00"
          onChange={(val) => {
            chamber.updatePhysics({ restitution: val / 100 });
            refresh();
          }}
        />
        <Knob
          label="QUANTIZE"
          value={Math.round(chamber.getConfig().quantize * 100)}
          min={0}
          max={100}
          step={5}
          unit="%"
          accentColor="#FF6B35"
          onChange={(val) => {
            chamber.updateConfig({ quantize: val / 100 });
            refresh();
          }}
        />
        <Knob
          label="DROP EVERY"
          value={chamber.getConfig().autoDropBars}
          min={0}
          max={8}
          step={1}
          unit="bar"
          accentColor="#FF382E"
          onChange={(val) => {
            chamber.updateConfig({ autoDropBars: val });
            refresh();
          }}
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <button
          data-testid="chamber-drop"
          onClick={() => chamber.requestDrop()}
          className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg bg-lime-500 hover:bg-lime-400 text-jungle-950 text-[10px] font-mono font-bold tracking-wider"
        >
          <ArrowDownToLine size={12} />
          DROP BALL
          {chamber.pendingBarDropCount() > 0 && <span className="text-[9px] opacity-70">(+{chamber.pendingBarDropCount()} @ bar)</span>}
        </button>
        <button
          data-testid="chamber-drop-sync"
          title="Manual DROP: immediately, or quantised to the next bar start while playing"
          onClick={() => {
            chamber.updateConfig({ dropSync: chamber.getConfig().dropSync === 'bar' ? 'now' : 'bar' });
            refresh();
          }}
          className={`px-2 py-1.5 rounded-lg border text-[10px] font-mono ${
            chamber.getConfig().dropSync === 'bar'
              ? 'bg-mango-500 border-mango-400 text-jungle-950 font-bold'
              : 'bg-jungle-850 border-jungle-700 text-cream-200/70'
          }`}
        >
          {chamber.getConfig().dropSync === 'bar' ? 'ON BAR' : 'NOW'}
        </button>
        <button
          data-testid="chamber-clear"
          onClick={() => chamber.clearBalls()}
          className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-jungle-850 hover:bg-tomato-950/60 border border-jungle-700 text-cream-200 text-[10px] font-mono"
        >
          <Trash2 size={12} className="text-tomato-400" />
          CLEAR
        </button>
        <span className="text-[10px] font-mono text-cream-200/60 whitespace-nowrap" data-testid="chamber-ball-count">
          {balls} BALL{balls === 1 ? '' : 'S'}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <button
          data-testid="chamber-mapping-toggle"
          onClick={() => setShowMapping((v) => !v)}
          className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1 rounded-lg border text-[10px] font-mono ${
            showMapping ? 'bg-jungle-800 border-jungle-600 text-cream-100' : 'bg-jungle-850 border-jungle-700 text-cream-200/70'
          }`}
        >
          <Sliders size={11} className="text-papaya-400" />
          MAPPING {showMapping ? '▲' : '▼'}
        </button>
        <button
          data-testid="chamber-export"
          title="Download this chamber (geometry, balls, mapping, settings) as JSON"
          onClick={() => downloadJson({ chamber: chamber.exportConfig() }, 'tropicflow-chamber.json')}
          className="flex items-center gap-1 px-2 py-1 rounded-lg bg-jungle-850 border border-jungle-700 text-cream-200/70 text-[10px] font-mono"
        >
          <Download size={11} />
          EXPORT
        </button>
        <button
          data-testid="chamber-import"
          title="Load a chamber JSON (or a bounce .score.json)"
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1 px-2 py-1 rounded-lg bg-jungle-850 border border-jungle-700 text-cream-200/70 text-[10px] font-mono"
        >
          <Upload size={11} />
          IMPORT
        </button>
        <input
          ref={fileInputRef}
          data-testid="chamber-import-input"
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) importChamber(f);
            e.target.value = '';
          }}
        />
      </div>
      {showMapping && <ChamberMappingPanel chamber={chamber} />}
      <p className="text-[9px] font-mono text-cream-200/40 leading-tight">
        Click: drop · Shift+click: peg · Ctrl+drag: ramp · Drag peg · Wheel: note · Alt+click: remove.
      </p>
    </div>
  );
};

export default ChamberCard;
