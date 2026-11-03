import React, { useRef, useState, useEffect, useCallback } from 'react';
import type { PatchCable } from '../../core/graph/GraphTypes.ts';
import { makeCable } from '../../core/graph/PatchRouter.ts';
import { ModuleCard, cardWidthPx } from './ModuleCard.tsx';
import { ModuleBrowser } from './ModuleBrowser.tsx';
import { useRack } from './useRack.ts';
import { stairsLayout } from '../../core/graph/StairsLayout.ts';
import { CableRenderer } from '../../core/canvas/CableRenderer.ts';
import { EventBus } from '../../core/events/EventBus.ts';
import type { PatchToggleRequestEvent } from '../../core/events/DomainEvents.ts';
import { Trash2, ChevronsDownUp, ChevronsUpDown, Layers, PackagePlus, RotateCcw, Eraser } from 'lucide-react';

let cableCounter = 0;
const CABLE_COLORS = ['#FF9E00', '#FF382E', '#70E000', '#FF6B35'];

/**
 * The rack on screen. The engine owns the modules (rack) and the cables
 * (patch); every edit here goes through it and the view re-reads.
 */
export const ModularCanvas: React.FC = () => {
  const { engine, nodes, cables } = useRack();
  /** Minimised cards (single header row, jacks still reachable). */
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [browserOpen, setBrowserOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  /** Edit the patch: the engine applies it and notifies every view. */
  const setCables = useCallback(
    (update: (prev: PatchCable[]) => PatchCable[]) => {
      engine.applyPatch(update(engine.getPatch()));
    },
    [engine]
  );

  // Panels (e.g. the soundboard's instrument chips) plug/unplug through the canvas.
  useEffect(() => {
    return EventBus.getInstance().subscribe<PatchToggleRequestEvent>('PATCH_TOGGLE_REQUEST', (e) => {
      setCables((prev) => {
        const existing = prev.filter((c) => c.fromPortId === e.fromPortId && c.toPortId === e.toPortId);
        if (existing.length) return prev.filter((c) => !existing.includes(c));
        const cable = makeCable(engine.rack.nodes(), e.fromPortId, e.toPortId, `cable-u${++cableCounter}`, CABLE_COLORS[cableCounter % CABLE_COLORS.length]);
        return cable ? [...prev, cable] : prev;
      });
    });
  }, [engine, setCables]);

  const toggleCollapsed = useCallback((nodeId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  }, []);

  const draggingNodeRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);

  const [activeCable, setActiveCable] = useState<{
    fromNodeId: string;
    fromPortId: string;
    isOutput: boolean;
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
    color: string;
  } | null>(null);

  const getPortCoordinates = useCallback((portId: string): { x: number; y: number } | null => {
    if (!containerRef.current) return null;
    const portEl = containerRef.current.querySelector(`[data-port-id="${portId}"]`);
    if (!portEl) return null;

    const containerRect = containerRef.current.getBoundingClientRect();
    const portRect = portEl.getBoundingClientRect();

    return {
      x: portRect.left - containerRect.left + 8,
      y: portRect.top - containerRect.top + 8,
    };
  }, []);

  /**
   * Cables are drawn on demand, not on every frame: when cables, cards
   * (position, size, minimised, a lazily loaded body) or the cable being
   * dragged change. One frame per change, coalesced.
   */
  const drawCables = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const cable of cables) {
      const p1 = getPortCoordinates(cable.fromPortId);
      const p2 = getPortCoordinates(cable.toPortId);
      if (p1 && p2) CableRenderer.renderCable(ctx, p1.x, p1.y, p2.x, p2.y, cable.color);
    }
    if (activeCable) {
      CableRenderer.renderCable(ctx, activeCable.startX, activeCable.startY, activeCable.currentX, activeCable.currentY, activeCable.color);
    }
  }, [cables, activeCable, getPortCoordinates]);

  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        drawCables();
      });
    };
    schedule();
    // Cards change size when a body loads or a card is minimised: jacks move, cables follow.
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
    const container = containerRef.current;
    if (observer && container) {
      observer.observe(container);
      for (const card of container.querySelectorAll('[data-module-type]')) observer.observe(card);
    }
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [drawCables, nodes, collapsed]);

  const handleDragStart = (e: React.MouseEvent, nodeId: string) => {
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;

    draggingNodeRef.current = {
      id: nodeId,
      offsetX: e.clientX - node.position.x,
      offsetY: e.clientY - node.position.y,
    };
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (draggingNodeRef.current) {
      const { id, offsetX, offsetY } = draggingNodeRef.current;
      const nextX = Math.max(10, e.clientX - offsetX);
      const nextY = Math.max(10, e.clientY - offsetY);

      engine.rack.moveNode(id, { x: nextX, y: nextY });
    }

    if (activeCable && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      setActiveCable((prev) =>
        prev
          ? {
              ...prev,
              currentX: e.clientX - rect.left,
              currentY: e.clientY - rect.top,
            }
          : null
      );
    }
  };

  const handleMouseUp = () => {
    draggingNodeRef.current = null;
    if (activeCable) {
      setActiveCable(null);
    }
  };

  /** Dropping a dragged cable on a jack creates the connection (if legal). */
  const handlePortMouseUp = (e: React.MouseEvent, _nodeId: string, portId: string) => {
    if (!activeCable) return;
    e.stopPropagation();
    const cable = makeCable(nodes, activeCable.fromPortId, portId, `cable-u${++cableCounter}`, activeCable.color);
    setActiveCable(null);
    draggingNodeRef.current = null;
    if (!cable) return;
    setCables((prev) => {
      const duplicate = prev.some(
        (c) => c.fromPortId === cable.fromPortId && c.toPortId === cable.toPortId
      );
      return duplicate ? prev : [...prev, cable];
    });
  };

  /** Double-clicking a jack unplugs every cable attached to it. */
  const handlePortDoubleClick = (_e: React.MouseEvent, _nodeId: string, portId: string) => {
    setCables((prev) => prev.filter((c) => c.fromPortId !== portId && c.toPortId !== portId));
  };

  const handlePortMouseDown = (
    e: React.MouseEvent,
    nodeId: string,
    portId: string,
    isOutput: boolean
  ) => {
    e.stopPropagation();
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const portPos = getPortCoordinates(portId) || {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    };

    const randomColor = CABLE_COLORS[cableCounter % CABLE_COLORS.length];

    setActiveCable({
      fromNodeId: nodeId,
      fromPortId: portId,
      isOutput,
      startX: portPos.x,
      startY: portPos.y,
      currentX: portPos.x,
      currentY: portPos.y,
      color: randomColor,
    });
  };

  const clearCables = () => setCables(() => []);

  // A loaded preset shows its cards expanded (RESET PATCH, CLEAR ALL, the browser's presets, the console).
  useEffect(() => engine.rack.subscribe((change) => change === 'reset' && setCollapsed(new Set())), [engine]);

  /** RESET PATCH: the default rack, wired as it always was. */
  const resetPatch = () => {
    void engine.resetRack();
  };

  /** CLEAR ALL: remove (and unload) every module; cables go with them. */
  const clearRack = () => {
    engine.clearRack();
    setCollapsed(new Set());
  };

  const removeModule = (id: string) => {
    engine.removeModule(id);
    setCollapsed((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  /** A free spot for a new card: right of the rightmost card while it fits, else a cascade from the top-left. */
  const placeNew = (type: string): { x: number; y: number } => {
    const el = containerRef.current;
    const width = cardWidthPx(type);
    const current = engine.rack.nodes();
    if (current.length === 0) return { x: 30, y: 50 };
    const rightmost = current.reduce((best, n) => (n.position.x > best.position.x ? n : best), current[0]);
    const x = rightmost.position.x + cardWidthPx(rightmost.type) + 24;
    if (!el || x + width <= el.clientWidth - 10) return { x, y: rightmost.position.y };
    const k = current.length % 8;
    return { x: 60 + 28 * k, y: 80 + 28 * k };
  };

  const addModule = (type: string) => {
    void engine.addModule(type, placeNew(type));
  };

  const counts: Record<string, number> = {};
  for (const n of nodes) counts[n.type] = (counts[n.type] ?? 0) + 1;

  const allCollapsed = nodes.every((n) => collapsed.has(n.id));
  const collapseAll = () => setCollapsed(allCollapsed ? new Set() : new Set(nodes.map((n) => n.id)));

  /**
   * STACK: minimise every card and lay them out as stairs sized to the visible
   * canvas. Rows per column = what the height allows; columns = as many as
   * needed (balanced); inside a column the horizontal step is chosen so the
   * stair spans the column's full width.
   */
  const stackAsStairs = () => {
    const el = containerRef.current;
    if (!el) return;
    const layout = stairsLayout(
      nodes.map((n) => ({ id: n.id, width: cardWidthPx(n.type) })),
      el.clientWidth,
      el.clientHeight
    );
    setCollapsed(new Set(nodes.map((n) => n.id)));
    for (const n of nodes) {
      const pos = layout.get(n.id);
      if (pos) engine.rack.moveNode(n.id, pos);
    }
  };

  return (
    <div
      ref={containerRef}
      data-testid="modular-canvas"
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      className="relative flex-1 w-full h-full bg-jungle-950 tropical-grid overflow-hidden"
    >
      <div className="absolute top-3 right-4 z-30 flex items-center gap-2">
        <button
          data-testid="add-module"
          onClick={() => setBrowserOpen(true)}
          title="Browse the available modules and add one to the rack"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-lime-500 hover:bg-lime-400 border border-lime-400 text-jungle-950 text-xs font-mono font-bold transition-colors shadow-md"
        >
          <PackagePlus size={13} />
          ADD MODULE
        </button>
        <button
          data-testid="stack"
          onClick={stackAsStairs}
          title="Minimise every module and arrange them as stairs across the visible canvas"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-jungle-850 hover:bg-jungle-800 border border-jungle-700 text-cream-200 text-xs font-mono font-medium transition-colors shadow-md"
        >
          <Layers size={13} className="text-papaya-400" />
          STACK
        </button>
        <button
          data-testid="collapse-all"
          onClick={collapseAll}
          title={allCollapsed ? 'Expand every module' : 'Minimise every module to a single row'}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-jungle-850 hover:bg-jungle-800 border border-jungle-700 text-cream-200 text-xs font-mono font-medium transition-colors shadow-md"
        >
          {allCollapsed ? <ChevronsUpDown size={13} className="text-mango-400" /> : <ChevronsDownUp size={13} className="text-mango-400" />}
          {allCollapsed ? 'MAX ALL' : 'MIN ALL'}
        </button>
        <button
          data-testid="reset-patch"
          onClick={resetPatch}
          title="Load the default rack: every module, wired as on start-up"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-jungle-850 hover:bg-jungle-800 border border-jungle-700 text-cream-200 text-xs font-mono font-medium transition-colors shadow-md"
        >
          <RotateCcw size={13} className="text-lime-400" />
          RESET PATCH
        </button>
        <button
          data-testid="disconnect-all"
          onClick={clearCables}
          title="Unplug every cable (modules stay)"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-jungle-850 hover:bg-tomato-950/60 border border-jungle-700 hover:border-tomato-500/60 text-cream-200 text-xs font-mono font-medium transition-colors shadow-md"
        >
          <Trash2 size={13} className="text-tomato-400" />
          DISCONNECT ALL
        </button>
        <button
          data-testid="clear-all"
          onClick={clearRack}
          title="Remove and unload every module (cables go with them)"
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-jungle-850 hover:bg-tomato-950/60 border border-jungle-700 hover:border-tomato-500/60 text-cream-200 text-xs font-mono font-medium transition-colors shadow-md"
        >
          <Eraser size={13} className="text-tomato-400" />
          CLEAR ALL
        </button>
      </div>

      {nodes.length === 0 && (
        <div className="absolute inset-0 z-0 flex items-center justify-center pointer-events-none" data-testid="empty-rack">
          <div className="text-center font-mono">
            <p className="text-sm text-cream-200/60">The rack is empty - nothing is loaded.</p>
            <p className="text-[11px] text-cream-200/40 mt-1">
              <span className="text-lime-400">ADD MODULE</span> to pick modules, or <span className="text-lime-400">RESET PATCH</span> for the default setup.
            </p>
          </div>
        </div>
      )}

      <ModuleBrowser
        open={browserOpen}
        onClose={() => setBrowserOpen(false)}
        counts={counts}
        onAdd={addModule}
        onLoadPreset={(name) => void engine.loadPreset(name)}
      />

      <canvas
        ref={canvasRef}
        width={2000}
        height={1200}
        className="patch-cable-layer z-20"
      />

      {nodes.map((node) => (
        <ModuleCard
          key={node.id}
          node={node}
          collapsed={collapsed.has(node.id)}
          onToggleCollapsed={toggleCollapsed}
          onRemove={removeModule}
          onDragStart={handleDragStart}
          onPortMouseDown={handlePortMouseDown}
          onPortMouseUp={handlePortMouseUp}
          onPortDoubleClick={handlePortDoubleClick}
        />
      ))}
    </div>
  );
};
