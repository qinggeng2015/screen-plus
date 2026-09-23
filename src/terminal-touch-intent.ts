type TerminalTouchPoint = {
  id: number;
  x: number;
  y: number;
};

function isValidPoint(point: TerminalTouchPoint) {
  return Number.isInteger(point.id) && Number.isFinite(point.x) && Number.isFinite(point.y);
}

export function createTerminalTouchIntent(now: () => number) {
  let pending: { point: TerminalTouchPoint; startedAt: number } | null = null;

  function cancel() {
    pending = null;
  }

  function start(point: TerminalTouchPoint, interruptedScroll: boolean) {
    cancel();
    const startedAt = now();
    // A touch that stops momentum belongs to browsing, even when the finger
    // stays still. Only a subsequent independent tap can request the keyboard.
    if (interruptedScroll || !isValidPoint(point) || !Number.isFinite(startedAt)) return;
    pending = { point: { ...point }, startedAt };
  }

  function move(_point: TerminalTouchPoint) {
    // Do not turn a short scroll, or a drag back to its origin, into a tap.
    // A mismatched touch also invalidates this single-finger gesture.
    cancel();
  }

  function end(point: TerminalTouchPoint) {
    const gesture = pending;
    cancel();
    if (!gesture || !isValidPoint(point) || gesture.point.id !== point.id) return false;

    const endedAt = now();
    const duration = endedAt - gesture.startedAt;
    if (!Number.isFinite(endedAt) || duration < 0 || duration > 350) return false;
    return Math.hypot(point.x - gesture.point.x, point.y - gesture.point.y) <= 3;
  }

  return { start, move, end, cancel };
}
