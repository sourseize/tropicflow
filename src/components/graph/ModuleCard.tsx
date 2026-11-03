import React, { Suspense, useCallback, useState } from 'react';
import { X } from 'lucide-react';
import { AudioEngine } from '../../core/audio/AudioEngine.ts';
import type { GraphNode, ModulePort } from '../../core/graph/GraphTypes.ts';
import type { ModuleDescriptor, ModuleInstance } from '../../core/modules/ModuleContract.ts';
import { moduleRegistry } from '../../core/modules/ModuleRegistry.ts';
import { Badge } from '../ui/Badge.tsx';
import type { ModuleBody, ModuleBodyProps } from './ModuleBody.ts';
import { cardLoaderFor, preloadedCard } from './cardRegistry.ts';
import '../../modules/cards.ts';

interface ModuleCardProps {
  node: GraphNode;
  /** Minimised: a single header row with the jacks inline (cables keep working). */
  collapsed: boolean;
  onToggleCollapsed: (nodeId: string) => void;
  onRemove: (nodeId: string) => void;
  onDragStart: (e: React.MouseEvent, nodeId: string) => void;
  onPortMouseDown: (e: React.MouseEvent, nodeId: string, portId: string, isOutput: boolean) => void;
  onPortMouseUp: (e: React.MouseEvent, nodeId: string, portId: string) => void;
  onPortDoubleClick: (e: React.MouseEvent, nodeId: string, portId: string) => void;
}

/** Tailwind class per card width the descriptors use (classes must be literal for the build). */
const WIDTH_CLASS: Record<number, string> = { 224: 'w-56', 288: 'w-72', 320: 'w-80' };

/** Rendered width of a card in px, from its plugin descriptor (for layouts computed by the canvas). */
export function cardWidthPx(type: GraphNode['type']): number {
  return moduleRegistry.has(type) ? moduleRegistry.get(type).cardWidthPx : 288;
}

/** Card bodies are code-split per plugin and loaded on first render of that type (or preloaded at boot). */
const bodies: Map<string, React.LazyExoticComponent<ModuleBody>> = new Map();

function bodyFor(descriptor: ModuleDescriptor): React.ComponentType<ModuleBodyProps> | null {
  const ready = preloadedCard(descriptor);
  if (ready) return ready as React.ComponentType<ModuleBodyProps>;
  const load = cardLoaderFor(descriptor);
  if (!load) return null;
  let lazy = bodies.get(descriptor.type);
  if (!lazy) {
    lazy = React.lazy(() => load() as Promise<{ default: ModuleBody }>);
    bodies.set(descriptor.type, lazy);
  }
  return lazy;
}

const borderThemes = {
  mango: 'border-mango-500/50 hover:border-mango-400',
  tomato: 'border-tomato-500/50 hover:border-tomato-400',
  lime: 'border-lime-500/50 hover:border-lime-400',
  papaya: 'border-papaya-500/50 hover:border-papaya-400',
};

/**
 * The generic card: header (drag / minimise / remove), the plugin's body and
 * the jacks. Everything module-specific comes from the descriptor and the
 * instance; the body is the plugin's own component.
 */
export const ModuleCard: React.FC<ModuleCardProps> = ({
  node,
  collapsed,
  onToggleCollapsed,
  onRemove,
  onDragStart,
  onPortMouseDown,
  onPortMouseUp,
  onPortDoubleClick,
}) => {
  const [, forceUpdate] = useState({});
  /** Where the header mousedown happened: a mouseup within a few px is a click (toggle), further is a drag (move). */
  const headerPressRef = React.useRef<{ x: number; y: number } | null>(null);
  const refresh = useCallback(() => forceUpdate({}), []);
  // The live instance behind the node, looked up here (not passed down) so the canvas never retains it.
  const instance: ModuleInstance | null = AudioEngine.getInstance().rack.get(node.id);
  if (!instance) return null;
  const Body = bodyFor(instance.descriptor);
  const bodyProps: ModuleBodyProps = { instance, node, refresh };

  /** A jack: the 16 px dot carries data-port-id (cable anchor at +8, +8); the label is dropped when compact. */
  const jack = (port: ModulePort, isOutput: boolean, compact: boolean, row: boolean = false) => (
    <div
      key={port.id}
      data-port-id={port.id}
      title={`${port.name} (${port.type})`}
      onMouseDown={(e) => onPortMouseDown(e, node.id, port.id, isOutput)}
      onMouseUp={(e) => onPortMouseUp(e, node.id, port.id)}
      onDoubleClick={(e) => onPortDoubleClick(e, node.id, port.id)}
      className={`flex items-center gap-1.5 cursor-pointer group ${isOutput && !compact && !row ? 'flex-row-reverse' : ''}`}
    >
      <div
        className="w-4 h-4 rounded-full border-2 bg-jungle-950 flex items-center justify-center transition-transform group-hover:scale-125"
        style={{ borderColor: port.color }}
      >
        <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: port.color }} />
      </div>
      {!compact && <span className="text-cream-200/70 group-hover:text-cream-100">{port.name}</span>}
    </div>
  );

  return (
    <div
      data-testid={`module-${node.id}`}
      data-module-type={node.type}
      data-collapsed={collapsed ? 'true' : 'false'}
      style={{ left: `${node.position.x}px`, top: `${node.position.y}px` }}
      className={`absolute ${WIDTH_CLASS[cardWidthPx(node.type)] ?? 'w-72'} bg-jungle-900/95 backdrop-blur-md rounded-xl border-2 ${borderThemes[node.themeColor]} shadow-2xl select-none z-10 transition-shadow hover:shadow-glow-${node.themeColor}`}
    >
      <div
        data-testid={`module-header-${node.id}`}
        title="Click: minimise / maximise · Drag: move"
        onMouseDown={(e) => {
          headerPressRef.current = { x: e.clientX, y: e.clientY };
          onDragStart(e, node.id);
        }}
        onClick={(e) => {
          const press = headerPressRef.current;
          headerPressRef.current = null;
          if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 4) onToggleCollapsed(node.id);
        }}
        className={`flex items-center justify-between px-2.5 ${collapsed ? 'py-1 rounded-lg' : 'py-2 rounded-t-lg border-b border-jungle-750'} bg-jungle-850`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div
            className="w-2.5 h-2.5 rounded-full shrink-0"
            style={{ backgroundColor: node.accentHex, boxShadow: `0 0 8px ${node.accentHex}` }}
          />
          <span className="font-mono font-bold text-xs tracking-wider text-cream-100 truncate">{node.title}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {collapsed ? (
            <div className="flex items-center gap-1 text-[10px] font-mono" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
              {node.inputs.map((port) => jack(port, false, true))}
              {node.inputs.length > 0 && node.outputs.length > 0 && <span className="text-cream-200/30 px-0.5">|</span>}
              {node.outputs.map((port) => jack(port, true, true))}
            </div>
          ) : (
            <Badge variant={node.themeColor}>{node.type}</Badge>
          )}
          <button
            data-testid={`module-remove-${node.id}`}
            title="Remove this module from the rack (unloads it; its cables are cut)"
            aria-label={`Remove ${node.title}`}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(node.id);
            }}
            className="p-0.5 rounded text-cream-200/40 hover:text-tomato-400 hover:bg-jungle-800 transition-colors"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="p-3.5 flex flex-col gap-3">
          {Body && (
            <Suspense fallback={<div className="text-[10px] font-mono text-cream-200/40 py-2 text-center">loading…</div>}>
              <Body {...bodyProps} />
            </Suspense>
          )}

          {node.inputs.length === 0 && node.outputs.length <= 3 ? (
            // Output-only modules keep their jacks on one row (short labels) to stay compact.
            <div className="pt-2 border-t border-jungle-800 flex justify-between items-center text-[10px] font-mono">
              {node.outputs.map((port) => jack({ ...port, name: port.name.split(' ')[0] }, true, false, true))}
            </div>
          ) : (
            <div className="pt-2 border-t border-jungle-800 flex justify-between items-center text-[10px] font-mono">
              <div className="flex flex-col gap-1.5">{node.inputs.map((port) => jack(port, false, false))}</div>
              <div className="flex flex-col gap-1.5 items-end">{node.outputs.map((port) => jack(port, true, false))}</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
