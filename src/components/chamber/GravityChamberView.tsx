import React, { useEffect, useRef, useState } from 'react';
import { AudioEngine } from '../../core/audio/AudioEngine.ts';
import { ChamberRenderer } from '../../core/canvas/ChamberRenderer.ts';

interface Props {
  width?: number;
  height?: number;
}

let pegCounter = 100;
let segmentCounter = 100;
const MIN_RAMP_LENGTH = 0.05;

/**
 * Interactive view of the gravity chamber.
 *  - click: drop a ball at that x
 *  - shift+click: add a peg
 *  - ctrl/cmd+drag: draw a ramp
 *  - drag a peg to move it; alt+click (or right-click) a peg/ramp to remove it
 *  - mouse wheel over a peg/ramp: change its note (scale degree)
 * The drawing follows the *audible* time (ctx.currentTime), which trails the
 * simulation by the clock's lookahead, so hits flash when they sound.
 */
export const GravityChamberView: React.FC<Props> = ({ width = 296, height = 220 }) => {
  const engine = AudioEngine.getInstance();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragPegRef = useRef<string | null>(null);
  const movedRef = useRef(false);
  const draftRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [hoverPeg, setHoverPeg] = useState<string | null>(null);
  const [hoverSegment, setHoverSegment] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    const draw = () => {
      const chamber = engine.chamber;
      const now = engine.ctx.currentTime;
      const physics = chamber.physics.getConfig();
      const flashes = chamber.hitsAround(now).map((h) => ({
        x: h.event.position.x,
        y: h.event.position.y,
        age: h.age,
        track: h.track,
      }));
      ChamberRenderer.render(
        ctx,
        canvas.width,
        canvas.height,
        chamber.stateAt(now),
        chamber.physics.getPegs(),
        chamber.physics.getSegments(),
        physics.width,
        physics.height,
        flashes,
        { dropX: chamber.getConfig().dropX, hoverPegId: hoverPeg, hoverSegmentId: hoverSegment, draft: draftRef.current }
      );
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [engine, hoverPeg, hoverSegment]);

  // Wheel over a peg/ramp changes its scale degree. Registered natively so
  // preventDefault can stop the page from scrolling (React's is passive).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      const cfg = engine.chamber.physics.getConfig();
      const x = ((e.clientX - rect.left) / rect.width) * cfg.width;
      const y = ((e.clientY - rect.top) / rect.height) * cfg.height;
      const delta = e.deltaY < 0 ? 1 : -1;
      const peg = engine.chamber.physics.findPegAt(x, y);
      const seg = peg ? null : engine.chamber.physics.findSegmentAt(x, y);
      if (!peg && !seg) return;
      e.preventDefault();
      if (peg) engine.chamber.physics.setPegNote(peg.id, Math.max(-12, Math.min(24, peg.note + delta)));
      if (seg) engine.chamber.physics.setSegmentNote(seg.id, Math.max(-12, Math.min(24, seg.note + delta)));
      engine.chamber.updateConfig({});
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [engine]);

  const toChamber = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const cfg = engine.chamber.physics.getConfig();
    return {
      x: ((e.clientX - rect.left) / rect.width) * cfg.width,
      y: ((e.clientY - rect.top) / rect.height) * cfg.height,
    };
  };

  const onMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation(); // keep the module card from dragging
    e.preventDefault();
    const p = toChamber(e);
    const peg = engine.chamber.physics.findPegAt(p.x, p.y);
    const seg = peg ? null : engine.chamber.physics.findSegmentAt(p.x, p.y);
    movedRef.current = false;
    if ((peg || seg) && (e.altKey || e.button === 2)) {
      if (peg) engine.chamber.physics.removePeg(peg.id);
      if (seg) engine.chamber.physics.removeSegment(seg.id);
      engine.chamber.updateConfig({});
      return;
    }
    if (peg) {
      dragPegRef.current = peg.id;
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      draftRef.current = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
      return;
    }
    if (e.shiftKey) {
      const pegs = engine.chamber.physics.getPegs();
      engine.chamber.physics.addPeg({ id: `peg-u${++pegCounter}`, x: p.x, y: p.y, radius: 0.04, note: pegs.length % 8 });
      engine.chamber.updateConfig({});
      return;
    }
    engine.chamber.requestDrop(undefined, p.x);
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const p = toChamber(e);
    if (draftRef.current) {
      draftRef.current = { ...draftRef.current, x2: p.x, y2: p.y };
      return;
    }
    if (dragPegRef.current) {
      movedRef.current = true;
      engine.chamber.physics.movePeg(dragPegRef.current, p.x, p.y);
      return;
    }
    const peg = engine.chamber.physics.findPegAt(p.x, p.y);
    setHoverPeg(peg?.id ?? null);
    setHoverSegment(peg ? null : engine.chamber.physics.findSegmentAt(p.x, p.y)?.id ?? null);
  };

  const endDrag = () => {
    if (draftRef.current) {
      const d = draftRef.current;
      draftRef.current = null;
      if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) >= MIN_RAMP_LENGTH) {
        const segments = engine.chamber.physics.getSegments();
        engine.chamber.physics.addSegment({ id: `ramp-u${++segmentCounter}`, ...d, thickness: 0.012, note: segments.length % 8 });
        engine.chamber.updateConfig({});
      }
      return;
    }
    if (dragPegRef.current && movedRef.current) engine.chamber.updateConfig({});
    dragPegRef.current = null;
  };

  return (
    <canvas
      ref={canvasRef}
      data-testid="gravity-chamber"
      width={width}
      height={height}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
      onContextMenu={(e) => e.preventDefault()}
      className="w-full rounded-lg border border-jungle-800 cursor-crosshair block"
      style={{ height }}
      title="Click: drop ball · Shift+click: add peg · Ctrl+drag: draw ramp · Drag peg: move · Wheel: change note · Alt/right-click: remove"
    />
  );
};
