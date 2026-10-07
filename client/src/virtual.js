export const CARD_HEIGHT = 142;
export const GAP = 14;
// ponytail: fixed-height, truncated cards; use measured rows if full wrapping is needed.
const STRIDE = CARD_HEIGHT + GAP;

export function rowWindow(count, columns, scrollY, offset, viewport) {
  const rows = Math.ceil(count / columns);
  const start = Math.min(
    Math.max(0, rows - 1),
    Math.max(0, Math.floor((scrollY - offset) / STRIDE) - 4),
  );
  const end = Math.min(
    rows,
    Math.max(start + 1, Math.ceil((scrollY + viewport - offset) / STRIDE) + 4),
  );
  return {
    start: start * columns,
    end: Math.min(count, end * columns),
    top: start * STRIDE,
    height: Math.max(0, rows * STRIDE - GAP),
  };
}
