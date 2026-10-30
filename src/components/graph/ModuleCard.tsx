import React, { useEffect, useRef, useState } from 'react';
import type { GraphNode } from '../../core/graph/GraphTypes.ts';
import { AudioEngine } from '../../core/audio/AudioEngine.ts';
import { Knob } from '../ui/Knob.tsx';
import { Badge } from '../ui/Badge.tsx';
import { GravityChamberView } from '../chamber/GravityChamberView.tsx';
import { ChamberMappingPanel } from '../chamber/ChamberMappingPanel.tsx';
import { EventBus } from '../../core/events/EventBus.ts';
import type { ChamberConfig } from '../../core/physics/ChamberEngine.ts';
import { Move, ArrowDownToLine, Trash2, Download, Upload, Sliders } from 'lucide-react';

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

interface ModuleCardProps {
  node: GraphNode;
  onDragStart: (e: React.MouseEvent, nodeId: string) => void;
  onPortMouseDown: (e: React.MouseEvent, nodeId: string, portId: string, isOutput: boolean) => void;
  onPortMouseUp: (e: React.MouseEvent, nodeId: string, portId: string) => void;
  onPortDoubleClick: (e: React.MouseEvent, nodeId: string, portId: string) => void;
}

export const ModuleCard: React.FC<ModuleCardProps> = ({
  node,
  onDragStart,
  onPortMouseDown,
  onPortMouseUp,
  onPortDoubleClick,
}) => {
  const engine = AudioEngine.getInstance();
  const [, forceUpdate] = useState({});
  const [showMapping, setShowMapping] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refresh = () => forceUpdate({});

  const importChamber = (file: File) => {
    file.text().then((text) => {
      try {
        const parsed = JSON.parse(text) as Partial<ChamberConfig> & { chamber?: Partial<ChamberConfig> };
        // Accept a bare chamber config or a bounce score file that contains one.
        const cfg = parsed.chamber ?? (parsed as { config?: { chamber?: Partial<ChamberConfig> } }).config?.chamber ?? parsed;
        engine.chamber.loadConfig(cfg as Partial<ChamberConfig>);
        refresh();
      } catch (err) {
        console.error('[chamber] import failed', err);
      }
    });
  };

  // Ball count / geometry changes come from the chamber engine, not props.
  useEffect(() => {
    if (node.type !== 'chamber') return;
    return EventBus.getInstance().subscribe('CHAMBER_CHANGED', () => forceUpdate({}));
  }, [node.type]);

  const borderThemes = {
    mango: 'border-mango-500/50 hover:border-mango-400',
    tomato: 'border-tomato-500/50 hover:border-tomato-400',
    lime: 'border-lime-500/50 hover:border-lime-400',
    papaya: 'border-papaya-500/50 hover:border-papaya-400',
  };

  return (
    <div
      style={{ left: `${node.position.x}px`, top: `${node.position.y}px` }}
      className={`absolute ${node.type === 'chamber' ? 'w-80' : 'w-72'} bg-jungle-900/95 backdrop-blur-md rounded-xl border-2 ${borderThemes[node.themeColor]} shadow-2xl select-none z-10 transition-shadow hover:shadow-glow-${node.themeColor}`}
    >
      <div
        onMouseDown={(e) => onDragStart(e, node.id)}
        className="flex items-center justify-between px-3 py-2 bg-jungle-850 rounded-t-lg border-b border-jungle-750 cursor-grab active:cursor-grabbing"
      >
        <div className="flex items-center gap-2">
          <div
            className="w-2.5 h-2.5 rounded-full"
            style={{ backgroundColor: node.accentHex, boxShadow: `0 0 8px ${node.accentHex}` }}
          />
          <span className="font-mono font-bold text-xs tracking-wider text-cream-100">
            {node.title}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <Badge variant={node.themeColor}>{node.type}</Badge>
          <Move size={12} className="text-cream-200/40" />
        </div>
      </div>

      <div className="p-3.5 flex flex-col gap-3">
        {node.type === 'clock' && (
          <div className="grid grid-cols-2 gap-2">
            <Knob
              label="TEMPO"
              value={engine.clock.getBpm()}
              min={60}
              max={180}
              step={1}
              unit="BPM"
              accentColor="#70E000"
              onChange={(val) => {
                engine.clock.setBpm(val);
                refresh();
              }}
            />
            <Knob
              label="SWING"
              value={Math.round(engine.clock.getSwing() * 100)}
              min={0}
              max={40}
              step={1}
              unit="%"
              accentColor="#FF9E00"
              onChange={(val) => {
                engine.clock.setSwing(val / 100);
                refresh();
              }}
            />
          </div>
        )}

        {node.type === 'marimba' && (
          <div className="grid grid-cols-3 gap-1">
            <Knob
              label="MALLET"
              value={Number(engine.marimba.getParams().brightness.toFixed(1))}
              min={1}
              max={10}
              step={0.1}
              accentColor="#FF9E00"
              onChange={(val) => {
                engine.marimba.updateParam('brightness', val);
                refresh();
              }}
            />
            <Knob
              label="RING"
              value={Number(engine.marimba.getParams().decay.toFixed(2))}
              min={0.1}
              max={1.8}
              step={0.05}
              unit="s"
              accentColor="#FF9E00"
              onChange={(val) => {
                engine.marimba.updateParam('decay', val);
                refresh();
              }}
            />
            <Knob
              label="VOL"
              value={Math.round(engine.marimba.getParams().volume * 100)}
              min={0}
              max={100}
              step={1}
              unit="%"
              accentColor="#FF9E00"
              onChange={(val) => {
                engine.marimba.updateParam('volume', val / 100);
                refresh();
              }}
            />
          </div>
        )}

        {node.type === 'percussion' && (
          <div className="grid grid-cols-3 gap-1">
            <Knob
              label="KICK TUNE"
              value={engine.drums.getParams().kickTune}
              min={80}
              max={220}
              step={2}
              unit="Hz"
              accentColor="#FF382E"
              onChange={(val) => {
                engine.drums.updateParam('kickTune', val);
                refresh();
              }}
            />
            <Knob
              label="SNARE SNAP"
              value={Math.round(engine.drums.getParams().snareSnap * 100)}
              min={10}
              max={100}
              step={5}
              unit="%"
              accentColor="#FF6B35"
              onChange={(val) => {
                engine.drums.updateParam('snareSnap', val / 100);
                refresh();
              }}
            />
            <Knob
              label="HAT SIZZLE"
              value={Number(engine.drums.getParams().hihatDecay.toFixed(2))}
              min={0.03}
              max={0.25}
              step={0.01}
              unit="s"
              accentColor="#70E000"
              onChange={(val) => {
                engine.drums.updateParam('hihatDecay', val);
                refresh();
              }}
            />
          </div>
        )}

        {node.type === 'synth' && (
          <div className="grid grid-cols-3 gap-1">
            <Knob
              label="CUTOFF"
              value={engine.synth.getParams().filterCutoff}
              min={200}
              max={6000}
              step={50}
              unit="Hz"
              accentColor="#FF6B35"
              onChange={(val) => {
                engine.synth.updateParam('filterCutoff', val);
                refresh();
              }}
            />
            <Knob
              label="RES"
              value={Number(engine.synth.getParams().filterResonance.toFixed(1))}
              min={0.5}
              max={15}
              step={0.5}
              accentColor="#FF9E00"
              onChange={(val) => {
                engine.synth.updateParam('filterResonance', val);
                refresh();
              }}
            />
            <Knob
              label="DETUNE"
              value={engine.synth.getParams().detune}
              min={0}
              max={25}
              step={1}
              unit="ct"
              accentColor="#FF6B35"
              onChange={(val) => {
                engine.synth.updateParam('detune', val);
                refresh();
              }}
            />
          </div>
        )}

        {node.type === 'delay' && (
          <div className="grid grid-cols-3 gap-1">
            <Knob
              label="TIME"
              value={Math.round(engine.delay.getParams().time * 1000)}
              min={60}
              max={800}
              step={10}
              unit="ms"
              accentColor="#FF9E00"
              onChange={(val) => {
                engine.delay.setDelayTime(val / 1000);
                refresh();
              }}
            />
            <Knob
              label="FEEDBACK"
              value={Math.round(engine.delay.getParams().feedback * 100)}
              min={0}
              max={80}
              step={1}
              unit="%"
              accentColor="#FF9E00"
              onChange={(val) => {
                engine.delay.setFeedback(val / 100);
                refresh();
              }}
            />
            <Knob
              label="WET MIX"
              value={Math.round(engine.delay.getParams().mix * 100)}
              min={0}
              max={100}
              step={2}
              unit="%"
              accentColor="#FF9E00"
              onChange={(val) => {
                engine.delay.setMix(val / 100);
                refresh();
              }}
            />
          </div>
        )}

        {node.type === 'chamber' && (
          <div className="flex flex-col gap-2">
            <GravityChamberView />
            <div className="grid grid-cols-4 gap-1">
              <Knob
                label="GRAVITY"
                value={Number(engine.chamber.physics.getConfig().gravity.y.toFixed(1))}
                min={0.5}
                max={8}
                step={0.1}
                accentColor="#70E000"
                onChange={(val) => {
                  engine.chamber.updatePhysics({ gravity: { x: 0, y: val } });
                  refresh();
                }}
              />
              <Knob
                label="BOUNCE"
                value={Math.round(engine.chamber.physics.getConfig().restitution * 100)}
                min={20}
                max={98}
                step={1}
                unit="%"
                accentColor="#FF9E00"
                onChange={(val) => {
                  engine.chamber.updatePhysics({ restitution: val / 100 });
                  refresh();
                }}
              />
              <Knob
                label="QUANTIZE"
                value={Math.round(engine.chamber.getConfig().quantize * 100)}
                min={0}
                max={100}
                step={5}
                unit="%"
                accentColor="#FF6B35"
                onChange={(val) => {
                  engine.chamber.updateConfig({ quantize: val / 100 });
                  refresh();
                }}
              />
              <Knob
                label="DROP EVERY"
                value={engine.chamber.getConfig().autoDropBars}
                min={0}
                max={8}
                step={1}
                unit="bar"
                accentColor="#FF382E"
                onChange={(val) => {
                  engine.chamber.updateConfig({ autoDropBars: val });
                  refresh();
                }}
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <button
                data-testid="chamber-drop"
                onClick={() => engine.chamber.requestDrop()}
                className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-lg bg-lime-500 hover:bg-lime-400 text-jungle-950 text-[10px] font-mono font-bold tracking-wider"
              >
                <ArrowDownToLine size={12} />
                DROP BALL
                {engine.chamber.pendingBarDropCount() > 0 && (
                  <span className="text-[9px] opacity-70">(+{engine.chamber.pendingBarDropCount()} @ bar)</span>
                )}
              </button>
              <button
                data-testid="chamber-drop-sync"
                title="Manual DROP: immediately, or quantised to the next bar start while playing"
                onClick={() => {
                  engine.chamber.updateConfig({ dropSync: engine.chamber.getConfig().dropSync === 'bar' ? 'now' : 'bar' });
                  refresh();
                }}
                className={`px-2 py-1.5 rounded-lg border text-[10px] font-mono ${
                  engine.chamber.getConfig().dropSync === 'bar'
                    ? 'bg-mango-500 border-mango-400 text-jungle-950 font-bold'
                    : 'bg-jungle-850 border-jungle-700 text-cream-200/70'
                }`}
              >
                {engine.chamber.getConfig().dropSync === 'bar' ? 'ON BAR' : 'NOW'}
              </button>
              <button
                data-testid="chamber-clear"
                onClick={() => engine.chamber.clearBalls()}
                className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-jungle-850 hover:bg-tomato-950/60 border border-jungle-700 text-cream-200 text-[10px] font-mono"
              >
                <Trash2 size={12} className="text-tomato-400" />
                CLEAR
              </button>
              <span className="text-[10px] font-mono text-cream-200/60 whitespace-nowrap" data-testid="chamber-ball-count">
                {engine.chamber.getBalls().length} BALL{engine.chamber.getBalls().length === 1 ? '' : 'S'}
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
                onClick={() => downloadJson({ chamber: engine.chamber.exportConfig() }, 'tropicflow-chamber.json')}
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
            {showMapping && <ChamberMappingPanel />}
            <p className="text-[9px] font-mono text-cream-200/40 leading-tight">
              Click: drop · Shift+click: peg · Ctrl+drag: ramp · Drag peg · Wheel: note · Alt+click: remove.
            </p>
          </div>
        )}

        {node.type === 'master' && (
          <div className="grid grid-cols-2 gap-2">
            <Knob
              label="MASTER VOL"
              value={Math.round(engine.masterBus.getVolume() * 100)}
              min={0}
              max={100}
              step={1}
              unit="%"
              accentColor="#70E000"
              onChange={(val) => {
                engine.masterBus.setVolume(val / 100);
                refresh();
              }}
            />
            <div className="flex flex-col justify-center items-center p-2 bg-jungle-950 rounded-lg border border-jungle-800">
              <span className="text-[10px] font-mono text-lime-400 font-bold">ANALOG LIMITER</span>
              <span className="text-[9px] font-mono text-cream-200/50 mt-0.5">ACTIVE (-3dB)</span>
            </div>
          </div>
        )}

        <div className="pt-2 border-t border-jungle-800 flex justify-between items-center text-[10px] font-mono">
          <div className="flex flex-col gap-1.5">
            {node.inputs.map((port) => (
              <div
                key={port.id}
                data-port-id={port.id}
                onMouseDown={(e) => onPortMouseDown(e, node.id, port.id, false)}
                onMouseUp={(e) => onPortMouseUp(e, node.id, port.id)}
                onDoubleClick={(e) => onPortDoubleClick(e, node.id, port.id)}
                className="flex items-center gap-1.5 cursor-pointer group"
              >
                <div
                  className="w-4 h-4 rounded-full border-2 bg-jungle-950 flex items-center justify-center transition-transform group-hover:scale-125"
                  style={{ borderColor: port.color }}
                >
                  <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: port.color }} />
                </div>
                <span className="text-cream-200/70 group-hover:text-cream-100">{port.name}</span>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-1.5 items-end">
            {node.outputs.map((port) => (
              <div
                key={port.id}
                data-port-id={port.id}
                onMouseDown={(e) => onPortMouseDown(e, node.id, port.id, true)}
                onMouseUp={(e) => onPortMouseUp(e, node.id, port.id)}
                onDoubleClick={(e) => onPortDoubleClick(e, node.id, port.id)}
                className="flex items-center gap-1.5 cursor-pointer group flex-row-reverse"
              >
                <div
                  className="w-4 h-4 rounded-full border-2 bg-jungle-950 flex items-center justify-center transition-transform group-hover:scale-125"
                  style={{ borderColor: port.color }}
                >
                  <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: port.color }} />
                </div>
                <span className="text-cream-200/70 group-hover:text-cream-100">{port.name}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
