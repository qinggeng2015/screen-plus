import type { Terminal } from '@xterm/xterm';

export function createTerminalScrollHandler(
  terminal: Pick<Terminal, 'buffer' | 'modes' | 'dimensions' | 'scrollLines'>,
  sendWheel: (lines: number, x: number, y: number) => void
) {
  let remainingPixels = 0;
  let previousContext = '';
  let previousCellHeight = 0;

  function reset() {
    remainingPixels = 0;
    previousContext = '';
    previousCellHeight = 0;
  }

  function scroll(deltaY: number, x: number, y: number) {
    if (!Number.isFinite(deltaY) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const cellHeight = terminal.dimensions?.css.cell.height;
    if (cellHeight === undefined || !Number.isFinite(cellHeight) || cellHeight <= 0) {
      reset();
      return;
    }
    const bufferType = terminal.buffer.active.type;
    const mouseMode = terminal.modes.mouseTrackingMode;
    const context = `${bufferType}:${mouseMode}`;
    if (context !== previousContext || cellHeight !== previousCellHeight) remainingPixels = 0;
    previousContext = context;
    previousCellHeight = cellHeight;

    const pixels = remainingPixels + deltaY;
    const lines = Math.trunc(pixels / cellHeight);
    // Guard both arithmetic overflow and pathological event counts before
    // forwarding to the terminal or synthesizing application wheel events.
    if (!Number.isFinite(pixels) || !Number.isSafeInteger(lines)) {
      reset();
      return;
    }
    remainingPixels = pixels - lines * cellHeight;
    if (!Number.isFinite(remainingPixels)) {
      reset();
      return;
    }
    if (lines === 0) return;

    // X10 reports button presses only. It has no wheel protocol, so normal
    // scrollback must remain local just as it does with mouse tracking off.
    if (bufferType === 'normal' && (mouseMode === 'none' || mouseMode === 'x10')) {
      terminal.scrollLines(lines);
    } else {
      sendWheel(lines, x, y);
    }
  }

  return { scroll, reset };
}
