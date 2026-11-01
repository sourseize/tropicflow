/**
 * STACK layout: minimised cards arranged as stairs across the visible canvas.
 * Pure, so the UI and the unit tests share it.
 */

/** Height of a minimised card plus the gap left between rows. */
export const COLLAPSED_ROW_PX = 36;

/** Margins: left/right, top (below the canvas buttons), bottom. */
export const STAIRS_MARGIN = { x: 30, top: 50, bottom: 16 };

/**
 * Rows per column come from the available height; columns from the card
 * count (balanced); the step between rows in a column uses the column's
 * whole width, so the widest card of the column ends flush with its edge.
 */
export function stairsLayout(
  cards: Array<{ id: string; width: number }>,
  containerWidth: number,
  containerHeight: number,
  row: number = COLLAPSED_ROW_PX
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const n = cards.length;
  if (n === 0) return out;
  const rowsFit = Math.max(1, Math.floor((containerHeight - STAIRS_MARGIN.top - STAIRS_MARGIN.bottom) / row));
  const columns = Math.max(1, Math.ceil(n / rowsFit));
  const rows = Math.ceil(n / columns);
  const colWidth = Math.max(1, (containerWidth - 2 * STAIRS_MARGIN.x) / columns);
  for (let col = 0; col < columns; col++) {
    const slice = cards.slice(col * rows, (col + 1) * rows);
    const widest = Math.max(...slice.map((c) => c.width));
    const stepX = slice.length > 1 ? Math.max(0, (colWidth - widest) / (slice.length - 1)) : 0;
    slice.forEach((card, i) => {
      out.set(card.id, {
        x: Math.round(STAIRS_MARGIN.x + col * colWidth + i * stepX),
        y: STAIRS_MARGIN.top + i * row,
      });
    });
  }
  return out;
}
