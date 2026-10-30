import type { ChamberSnapshot, Peg, Segment } from '../physics/ChamberTypes.ts';

export interface ChamberHitFlash {
  x: number;
  y: number;
  age: number;
  track: string;
}

const TRACK_COLORS: Record<string, string> = {
  kick: '#FF382E',
  snare: '#FF6B35',
  hihat: '#70E000',
  marimba: '#FF9E00',
  synth: '#FFB733',
};

/** Draws a chamber snapshot. Pure function of its inputs; no engine access. */
export class ChamberRenderer {
  public static render(
    ctx: CanvasRenderingContext2D,
    width: number,
    height: number,
    snapshot: ChamberSnapshot,
    pegs: readonly Peg[],
    segments: readonly Segment[],
    chamberWidth: number,
    chamberHeight: number,
    flashes: ChamberHitFlash[],
    options: {
      dropX: number | null;
      hoverPegId?: string | null;
      hoverSegmentId?: string | null;
      /** Ramp being drawn by the user (chamber units). */
      draft?: { x1: number; y1: number; x2: number; y2: number } | null;
    } = { dropX: null }
  ): void {
    const sx = width / chamberWidth;
    const sy = height / chamberHeight;

    ctx.fillStyle = '#070f0a';
    ctx.fillRect(0, 0, width, height);

    // Subtle grid
    ctx.strokeStyle = 'rgba(43, 83, 61, 0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 8; i++) {
      ctx.moveTo((width * i) / 8, 0);
      ctx.lineTo((width * i) / 8, height);
      ctx.moveTo(0, (height * i) / 8);
      ctx.lineTo(width, (height * i) / 8);
    }
    ctx.stroke();

    // Walls with instrument colours
    ctx.lineWidth = 3;
    ctx.strokeStyle = TRACK_COLORS.kick;
    ctx.beginPath(); ctx.moveTo(0, height - 1.5); ctx.lineTo(width, height - 1.5); ctx.stroke();
    ctx.strokeStyle = TRACK_COLORS.snare;
    ctx.beginPath(); ctx.moveTo(0, 1.5); ctx.lineTo(width, 1.5); ctx.stroke();
    ctx.strokeStyle = TRACK_COLORS.hihat;
    ctx.beginPath(); ctx.moveTo(1.5, 0); ctx.lineTo(1.5, height); ctx.moveTo(width - 1.5, 0); ctx.lineTo(width - 1.5, height); ctx.stroke();

    // Drop marker
    if (options.dropX !== null) {
      ctx.strokeStyle = 'rgba(251, 248, 242, 0.35)';
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(options.dropX * sx, 0);
      ctx.lineTo(options.dropX * sx, 14);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Segments (ramps)
    ctx.lineCap = 'round';
    for (const seg of segments) {
      const hovered = options.hoverSegmentId === seg.id;
      ctx.strokeStyle = hovered ? '#ffd073' : TRACK_COLORS.synth;
      ctx.lineWidth = Math.max(2, seg.thickness * 2 * sx);
      ctx.beginPath();
      ctx.moveTo(seg.x1 * sx, seg.y1 * sy);
      ctx.lineTo(seg.x2 * sx, seg.y2 * sy);
      ctx.stroke();
      ctx.fillStyle = '#fbf8f2';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(String(seg.note), ((seg.x1 + seg.x2) / 2) * sx, ((seg.y1 + seg.y2) / 2) * sy - 4);
    }
    if (options.draft) {
      ctx.strokeStyle = 'rgba(255, 183, 51, 0.6)';
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(options.draft.x1 * sx, options.draft.y1 * sy);
      ctx.lineTo(options.draft.x2 * sx, options.draft.y2 * sy);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Pegs
    for (const peg of pegs) {
      const hovered = options.hoverPegId === peg.id;
      ctx.beginPath();
      ctx.arc(peg.x * sx, peg.y * sy, peg.radius * sx, 0, Math.PI * 2);
      ctx.fillStyle = hovered ? 'rgba(255, 158, 0, 0.45)' : 'rgba(255, 158, 0, 0.2)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = TRACK_COLORS.marimba;
      ctx.stroke();
      ctx.fillStyle = '#fbf8f2';
      ctx.font = '9px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(peg.note), peg.x * sx, peg.y * sy);
    }

    // Hit flashes
    for (const f of flashes) {
      const a = Math.max(0, 1 - f.age / 0.25);
      ctx.beginPath();
      ctx.arc(f.x * sx, f.y * sy, 6 + (1 - a) * 14, 0, Math.PI * 2);
      ctx.strokeStyle = TRACK_COLORS[f.track] ?? '#fff';
      ctx.globalAlpha = a;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Balls
    for (const b of snapshot.balls) {
      ctx.beginPath();
      ctx.arc(b.x * sx, b.y * sy, b.radius * sx, 0, Math.PI * 2);
      ctx.fillStyle = b.asleep ? 'rgba(245, 238, 225, 0.35)' : '#f5eee1';
      ctx.shadowColor = '#fbf8f2';
      ctx.shadowBlur = b.asleep ? 0 : 8;
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }
}
