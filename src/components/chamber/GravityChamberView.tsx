import React, { useEffect, useRef, useState } from 'react';
import { AudioEngine } from '../../core/audio/AudioEngine.ts';
import { ChamberRenderer } from '../../core/canvas/ChamberRenderer.ts';
import { EventBus } from '../../core/events/EventBus.ts';
import type { ChamberEngine } from '../../core/physics/ChamberEngine.ts';

interface Props {
  /** The chamber this view draws and edits (one per GRAVITY CHAMBER card). */
  chamber: ChamberEngine;
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
export const GravityChamberView: React.FC<Props> = ({ chamber, width = 296, height = 220 }) => {
  const engine = AudioEngine.getInstance();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragPegRef = useRef<string | null>(null);
  const movedRef = useRef(false);
  const draftRef = useRef<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [hoverPeg, setHoverPeg] = useState<string | null>(null);
  const [hoverSegment, setHoverSegment] = useState<string | null>(null);
  /** Ask for one frame (drawing a ramp / dragging a peg while the transport is stopped). */
  const redrawRef = useRef<() => void>(() => {});

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    let last = 0;
    const FRAME_MS = 1000 / 30;
    const draw = (time: number = 0) => {
      // 30 fps while animating (the physics runs on the audio clock; the view only follows it).
      if (time && time - last < FRAME_MS && engine.clock.getIsPlaying()) {
        raf = requestAnimationFrame(draw);
        return;
      }
      last = time;
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
      // Animate only while the transport runs (balls move, hits flash); otherwise one frame per change.
      if (engine.clock.getIsPlaying() && !document.hidden) raf = requestAnimationFrame(draw);
      else raf = 0;
    };
    const frame = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    redrawRef.current = frame;
    frame();
    const bus = EventBus.getInstance();
    const unsubs = [bus.subscribe('AUDIO_STARTED', frame), bus.subscribe('AUDIO_STOPPED', frame), bus.subscribe('CHAMBER_CHANGED', frame)];
    document.addEventListener('visibilitychange', frame);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      unsubs.forEach((u) => u());
      document.removeEventListener('visibilitychange', frame);
    };
  }, [engine, chamber, hoverPeg, hoverSegment]);

  // Wheel over a peg/ramp changes its scale degree. Registered natively so
  // preventDefault can stop the page from scrolling (React's is passive).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      const cfg = chamber.physics.getConfig();
      const x = ((e.clientX - rect.left) / rect.width) * cfg.width;
      const y = ((e.clientY - rect.top) / rect.height) * cfg.height;
      const delta = e.deltaY < 0 ? 1 : -1;
      const peg = chamber.physics.findPegAt(x, y);
      const seg = peg ? null : chamber.physics.findSegmentAt(x, y);
      if (!peg && !seg) return;
      e.preventDefault();
      if (peg) chamber.physics.setPegNote(peg.id, Math.max(-12, Math.min(24, peg.note + delta)));
      if (seg) chamber.physics.setSegmentNote(seg.id, Math.max(-12, Math.min(24, seg.note + delta)));
      chamber.updateConfig({});
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [chamber]);

  const toChamber = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const cfg = chamber.physics.getConfig();
    return {
      x: ((e.clientX - rect.left) / rect.width) * cfg.width,
      y: ((e.clientY - rect.top) / rect.height) * cfg.height,
    };
  };

  const onMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation(); // keep the module card from dragging
    e.preventDefault();
    const p = toChamber(e);
    const peg = chamber.physics.findPegAt(p.x, p.y);
    const seg = peg ? null : chamber.physics.findSegmentAt(p.x, p.y);
    movedRef.current = false;
    if ((peg || seg) && (e.altKey || e.button === 2)) {
      if (peg) chamber.physics.removePeg(peg.id);
      if (seg) chamber.physics.removeSegment(seg.id);
      chamber.updateConfig({});
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
      const pegs = chamber.physics.getPegs();
      chamber.physics.addPeg({ id: `peg-u${++pegCounter}`, x: p.x, y: p.y, radius: 0.04, note: pegs.length % 8 });
      chamber.updateConfig({});
      return;
    }
    chamber.requestDrop(undefined, p.x);
  };

  const onMouseMove = (e: React.MouseEvent) => {
    const p = toChamber(e);
    if (draftRef.current) {
      draftRef.current = { ...draftRef.current, x2: p.x, y2: p.y };
      redrawRef.current();
      return;
    }
    if (dragPegRef.current) {
      movedRef.current = true;
      chamber.physics.movePeg(dragPegRef.current, p.x, p.y);
      redrawRef.current();
      return;
    }
    const peg = chamber.physics.findPegAt(p.x, p.y);
    setHoverPeg(peg?.id ?? null);
    setHoverSegment(peg ? null : chamber.physics.findSegmentAt(p.x, p.y)?.id ?? null);
  };

  const endDrag = () => {
    if (draftRef.current) {
      const d = draftRef.current;
      draftRef.current = null;
      redrawRef.current();
      if (Math.hypot(d.x2 - d.x1, d.y2 - d.y1) >= MIN_RAMP_LENGTH) {
        const segments = chamber.physics.getSegments();
        chamber.physics.addSegment({ id: `ramp-u${++segmentCounter}`, ...d, thickness: 0.012, note: segments.length % 8 });
        chamber.updateConfig({});
      }
      return;
    }
    if (dragPegRef.current && movedRef.current) chamber.updateConfig({});
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
