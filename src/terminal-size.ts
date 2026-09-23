// Keep these bounds aligned with server/terminal-size.cjs: the PTY and xterm must
// use the same geometry, including when the fitted viewport exceeds the limits.
function normalizeDimension(value: unknown, fallback: number, min: number, max: number) {
  const number = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(number) && number > 0
    ? Math.max(min, Math.min(max, Math.floor(number)))
    : fallback;
}

export function normalizeTerminalSize(cols?: unknown, rows?: unknown) {
  return {
    cols: normalizeDimension(cols, 120, 20, 300),
    rows: normalizeDimension(rows, 32, 6, 120)
  };
}
