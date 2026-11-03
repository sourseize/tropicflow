import React from 'react';
import { Plus, PackagePlus, LayoutGrid } from 'lucide-react';
import { RACK_PRESETS } from '../../core/modules/RackPreset.ts';
import { Modal } from '../ui/Modal.tsx';
import { Badge } from '../ui/Badge.tsx';
import { moduleRegistry } from '../../core/modules/ModuleRegistry.ts';
import type { ModuleDescriptor, ModulePortSpec } from '../../core/modules/ModuleContract.ts';
import { portFamily } from '../../core/graph/PatchRouter.ts';

interface ModuleBrowserProps {
  open: boolean;
  onClose: () => void;
  /** How many instances of each type are in the rack. */
  counts: Record<string, number>;
  onAdd: (type: string) => void;
  /** Replace the rack with a named preset (see RACK_PRESETS). */
  onLoadPreset: (name: string) => void;
}

const FAMILY_CLASS: Record<string, string> = {
  audio: 'border-mango-500/50 text-mango-300',
  trigger: 'border-lime-500/50 text-lime-300',
  cv: 'border-papaya-500/50 text-papaya-300',
};

const JackChip: React.FC<{ port: ModulePortSpec }> = ({ port }) => (
  <span className={`px-1 py-px rounded border text-[9px] font-mono ${FAMILY_CLASS[portFamily(port.type)]}`} title={port.type}>
    {port.type.endsWith('-in') ? '→ ' : ''}
    {port.name}
    {port.type.endsWith('-out') ? ' →' : ''}
  </span>
);

/** Lists every registered plugin; one click adds an instance to the rack. */
export const ModuleBrowser: React.FC<ModuleBrowserProps> = ({ open, onClose, counts, onAdd, onLoadPreset }) => {
  const modules: ModuleDescriptor[] = moduleRegistry.list();
  return (
    <Modal
      open={open}
      onClose={onClose}
      testId="module-browser"
      icon={<PackagePlus size={18} />}
      title="ADD MODULE"
      subtitle={`${modules.length} modules available · only what is in the rack is loaded`}
    >
      <div className="flex items-center gap-2 mb-3">
        <span className="text-[10px] font-mono text-cream-200/50 tracking-wider">PRESETS</span>
        {Object.entries(RACK_PRESETS).map(([name, p]) => (
          <button
            key={name}
            data-testid={`load-preset-${name}`}
            title={`${p.description} Replaces the current rack.`}
            onClick={() => onLoadPreset(name)}
            className="flex items-center gap-1 px-2 py-1 rounded-lg bg-jungle-850 hover:bg-jungle-800 border border-jungle-700 text-cream-200 text-[10px] font-mono font-bold tracking-wider"
          >
            <LayoutGrid size={11} className="text-mango-400" />
            {p.title} · {p.preset.modules.length}
          </button>
        ))}
      </div>
      <div className="flex flex-col gap-1.5 max-h-[60vh] overflow-y-auto pr-1">
        {modules.map((d) => {
          const count = counts[d.type] ?? 0;
          return (
            <div
              key={d.type}
              data-testid={`browser-module-${d.type}`}
              className="flex items-start gap-3 p-2.5 rounded-xl border border-jungle-800 bg-jungle-950/60 hover:border-jungle-600 transition-colors"
            >
              <div className="w-2.5 h-2.5 mt-1 rounded-full shrink-0" style={{ backgroundColor: d.accentHex, boxShadow: `0 0 8px ${d.accentHex}` }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-bold text-xs tracking-wider text-cream-100">{d.title}</span>
                  <Badge variant={d.theme}>{d.type}</Badge>
                  {count > 0 && (
                    <span className="text-[9px] font-mono text-cream-200/50" data-testid={`browser-count-${d.type}`}>
                      in rack ×{count}
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-cream-200/60 mt-0.5 leading-snug">{d.description}</p>
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {d.ports.map((p) => (
                    <JackChip key={p.id} port={p} />
                  ))}
                </div>
              </div>
              <button
                data-testid={`add-module-${d.type}`}
                onClick={() => onAdd(d.type)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-lime-500 hover:bg-lime-400 text-jungle-950 text-[10px] font-mono font-bold tracking-wider shrink-0"
              >
                <Plus size={12} />
                ADD
              </button>
            </div>
          );
        })}
      </div>
    </Modal>
  );
};
