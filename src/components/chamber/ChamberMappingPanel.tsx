import React, { useState } from 'react';
import type { ChamberEngine } from '../../core/physics/ChamberEngine.ts';
import {
  ROOT_NOTES,
  SCALES,
  SURFACE_CHOICES,
  SURFACE_KEYS,
  type SurfaceChoice,
  type SurfaceKey,
  scaleName,
  surfaceChoice,
  surfaceMappingFromChoice,
} from '../../core/physics/CollisionMapper.ts';
import { Knob } from '../ui/Knob.tsx';

const SURFACE_LABELS: Record<SurfaceKey, string> = {
  floor: 'FLOOR',
  ceiling: 'CEILING',
  left: 'LEFT WALL',
  right: 'RIGHT WALL',
  peg: 'PEGS',
  segment: 'RAMPS',
  ball: 'BALL × BALL',
};

const CHOICE_LABELS: Record<SurfaceChoice, string> = {
  kick: 'Kick',
  snare: 'Snare',
  hihat: 'Hi-hat (closed)',
  'hihat-open': 'Hi-hat (open)',
  marimba: 'Marimba',
  synth: 'Synth',
  none: '— silent —',
};

/** Edits the collision -> note mapping of a chamber. */
export const ChamberMappingPanel: React.FC<{ chamber: ChamberEngine }> = ({ chamber }) => {
  const [, bump] = useState({});
  const refresh = () => bump({});
  const mapping = chamber.getConfig().mapping;
  const currentScale = scaleName(mapping.scale) ?? 'custom';
  const currentRoot = Object.entries(ROOT_NOTES).find(([, hz]) => Math.abs(hz - mapping.rootHz) < 0.01)?.[0] ?? 'custom';

  const selectClass =
    'bg-jungle-950 border border-jungle-800 rounded text-[10px] font-mono text-cream-200 px-1 py-0.5 w-full';

  return (
    <div className="flex flex-col gap-2" data-testid="chamber-mapping">
      <div className="grid grid-cols-2 gap-x-2 gap-y-1">
        {SURFACE_KEYS.map((key) => (
          <label key={key} className="flex items-center justify-between gap-1 text-[9px] font-mono text-cream-200/70">
            <span className="whitespace-nowrap">{SURFACE_LABELS[key]}</span>
            <select
              data-testid={`mapping-${key}`}
              className={selectClass + ' max-w-[110px]'}
              value={surfaceChoice(mapping[key])}
              onChange={(e) => {
                chamber.updateMapping({ [key]: surfaceMappingFromChoice(e.target.value as SurfaceChoice) });
                refresh();
              }}
            >
              {SURFACE_CHOICES.map((c) => (
                <option key={c} value={c}>
                  {CHOICE_LABELS[c]}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-0.5 text-[9px] font-mono text-cream-200/70">
          SCALE
          <select
            data-testid="mapping-scale"
            className={selectClass}
            value={currentScale}
            onChange={(e) => {
              const scale = SCALES[e.target.value];
              if (scale) chamber.updateMapping({ scale: [...scale] });
              refresh();
            }}
          >
            {currentScale === 'custom' && <option value="custom">custom</option>}
            {Object.keys(SCALES).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-0.5 text-[9px] font-mono text-cream-200/70">
          ROOT
          <select
            data-testid="mapping-root"
            className={selectClass}
            value={currentRoot}
            onChange={(e) => {
              const hz = ROOT_NOTES[e.target.value];
              if (hz) chamber.updateMapping({ rootHz: hz });
              refresh();
            }}
          >
            {currentRoot === 'custom' && <option value="custom">custom</option>}
            {Object.keys(ROOT_NOTES).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid grid-cols-3 gap-1">
        <Knob
          label="VEL SCALE"
          value={Number(mapping.velocityScale.toFixed(1))}
          min={0.5}
          max={6}
          step={0.1}
          accentColor="#FF6B35"
          onChange={(val) => {
            chamber.updateMapping({ velocityScale: val });
            refresh();
          }}
        />
        <Knob
          label="MIN VEL"
          value={Math.round(mapping.minVelocity * 100)}
          min={5}
          max={100}
          step={5}
          unit="%"
          accentColor="#FF9E00"
          onChange={(val) => {
            chamber.updateMapping({ minVelocity: val / 100 });
            refresh();
          }}
        />
        <Knob
          label="SYNTH GATE"
          value={Math.round(mapping.synthDuration * 1000)}
          min={30}
          max={800}
          step={10}
          unit="ms"
          accentColor="#FFB733"
          onChange={(val) => {
            chamber.updateMapping({ synthDuration: val / 1000 });
            refresh();
          }}
        />
      </div>
    </div>
  );
};
