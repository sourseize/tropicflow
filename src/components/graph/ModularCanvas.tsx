import React, { useRef, useState, useEffect, useCallback } from 'react';
import type { GraphNode, PatchCable } from '../../core/graph/GraphTypes.ts';
import { INITIAL_NODES, INITIAL_CABLES } from '../../core/graph/NodeGraph.ts';
import { makeCable } from '../../core/graph/PatchRouter.ts';
import { AudioEngine } from '../../core/audio/AudioEngine.ts';
import { ModuleCard } from './ModuleCard.tsx';
import { CableRenderer } from '../../core/canvas/CableRenderer.ts';
import { Plus, Trash2 } from 'lucide-react';

let cableCounter = 0;
const CABLE_COLORS = ['#FF9E00', '#FF382E', '#70E000', '#FF6B35'];

export const ModularCanvas: React.FC = () => {
  const engine = AudioEngine.getInstance();
  const [nodes, setNodes] = useState<GraphNode[]>(INITIAL_NODES);
  const [cables, setCables] = useState<PatchCable[]>(() => engine.getPatch());
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Cables are the source of truth for audio routing and trigger gating.
  useEffect(() => {
    engine.applyPatch(cables);
  }, [cables, engine]);

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

  useEffect(() => {
    let animId: number;

    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      cables.forEach((cable) => {
        const p1 = getPortCoordinates(cable.fromPortId);
        const p2 = getPortCoordinates(cable.toPortId);
        if (p1 && p2) {
          CableRenderer.renderCable(ctx, p1.x, p1.y, p2.x, p2.y, cable.color);
        }
      });

      if (activeCable) {
        CableRenderer.renderCable(
          ctx,
          activeCable.startX,
          activeCable.startY,
          activeCable.currentX,
          activeCable.currentY,
          activeCable.color
        );
      }

      animId = requestAnimationFrame(draw);
    };

    animId = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animId);
  }, [cables, activeCable, getPortCoordinates]);

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

      setNodes((prev) =>
        prev.map((n) => (n.id === id ? { ...n, position: { x: nextX, y: nextY } } : n))
      );
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

  const clearCables = () => setCables([]);

  const resetPatch = () => {
    setNodes(INITIAL_NODES);
    setCables(INITIAL_CABLES);
  };

  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      className="relative flex-1 w-full h-full bg-jungle-950 tropical-grid overflow-hidden"
    >
      <div className="absolute top-3 right-4 z-30 flex items-center gap-2">
        <button
          onClick={resetPatch}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-jungle-850 hover:bg-jungle-800 border border-jungle-700 text-cream-200 text-xs font-mono font-medium transition-colors shadow-md"
        >
          <Plus size={13} className="text-lime-400" />
          RESET PATCH
        </button>
        <button
          onClick={clearCables}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-jungle-850 hover:bg-tomato-950/60 border border-jungle-700 hover:border-tomato-500/60 text-cream-200 text-xs font-mono font-medium transition-colors shadow-md"
        >
          <Trash2 size={13} className="text-tomato-400" />
          DISCONNECT ALL
        </button>
      </div>

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
          onDragStart={handleDragStart}
          onPortMouseDown={handlePortMouseDown}
          onPortMouseUp={handlePortMouseUp}
          onPortDoubleClick={handlePortDoubleClick}
        />
      ))}
    </div>
  );
};
