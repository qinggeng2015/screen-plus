// Keep these bounds aligned with src/terminal-size.ts. Both sides must clamp
// before resizing; otherwise cursor positioning and line wrapping diverge.
function normalizeDimension(value, fallback, min, max) {
  const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0
    ? Math.max(min, Math.min(max, Math.floor(number)))
    : fallback;
}

function normalizeTerminalSize(cols, rows) {
  return {
    cols: normalizeDimension(cols, 120, 20, 300),
    rows: normalizeDimension(rows, 32, 6, 120)
  };
}

module.exports = { normalizeTerminalSize };
