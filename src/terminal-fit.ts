type TerminalFitTiming = {
  requestFrame: (callback: () => void) => number;
  cancelFrame: (id: number) => void;
  setTimer: (callback: () => void, delay: number) => number;
  clearTimer: (id: number) => void;
};

export function createTerminalFitScheduler(fit: () => void, timing: TerminalFitTiming) {
  let frame: number | null = null;
  let settleTimer: number | null = null;
  let disposed = false;

  function cancelFrame() {
    if (frame === null) return;
    timing.cancelFrame(frame);
    frame = null;
  }

  function request(settleMs = 0) {
    if (disposed) return;

    if (settleMs > 0) {
      // Keep the current terminal grid while the viewport is animating. A fit
      // from ResizeObserver or another caller must not bypass this quiet period.
      cancelFrame();
      if (settleTimer !== null) timing.clearTimer(settleTimer);
      settleTimer = timing.setTimer(() => {
        settleTimer = null;
        request();
      }, settleMs);
      return;
    }

    if (settleTimer !== null || frame !== null) return;
    frame = timing.requestFrame(() => {
      frame = null;
      if (!disposed) fit();
    });
  }

  function flush() {
    if (disposed || settleTimer !== null) return;
    cancelFrame();
    fit();
  }

  function dispose() {
    disposed = true;
    cancelFrame();
    if (settleTimer !== null) {
      timing.clearTimer(settleTimer);
      settleTimer = null;
    }
  }

  return { request, flush, dispose };
}
