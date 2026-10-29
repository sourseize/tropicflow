import React, { useState } from 'react';
import { GraphNode } from '../../core/graph/GraphTypes';
import { AudioEngine } from '../../core/audio/AudioEngine';
import { Knob } from '../ui/Knob';
import { Badge } from '../ui/Badge';
import { Move } from 'lucide-react';

interface ModuleCardProps {
  node: GraphNode;
  onDragStart: (e: React.MouseEvent, nodeId: string) => void;
  onPortMouseDown: (e: React.MouseEvent, nodeId: string, portId: string, isOutput: boolean) => void;
}

export const ModuleCard: React.FC<ModuleCardProps> = ({
  node,
  onDragStart,
  onPortMouseDown,
}) => {
  const engine = AudioEngine.getInstance();
  const [, forceUpdate] = useState({});

  const refresh = () => forceUpdate({});

  const borderThemes = {
    mango: 'border-mango-500/50 hover:border-mango-400',
    tomato: 'border-tomato-500/50 hover:border-tomato-400',
    lime: 'border-lime-500/50 hover:border-lime-400',
    papaya: 'border-papaya-500/50 hover:border-papaya-400',
  };

  return (
    <div
      style={{ left: `${node.position.x}px`, top: `${node.position.y}px` }}
      className={`absolute w-72 bg-jungle-900/95 backdrop-blur-md rounded-xl border-2 ${borderThemes[node.themeColor]} shadow-2xl select-none z-10 transition-shadow hover:shadow-glow-${node.themeColor}`}
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
              value={320}
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
              value={38}
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
              value={40}
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

        {node.type === 'master' && (
          <div className="grid grid-cols-2 gap-2">
            <Knob
              label="MASTER VOL"
              value={85}
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
