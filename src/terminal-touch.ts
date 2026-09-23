export type TerminalTouchPoint = { id: number; x: number; y: number };

type TerminalTouchOptions = {
  onScroll: (deltaY: number, x: number, y: number) => void;
  onStart?: () => void;
  now: () => number;
  requestFrame: (callback: (time: number) => void) => number;
  cancelFrame: (id: number) => void;
};

const maxVelocity = 2.5;
const minVelocity = 0.02;
const maxFrameMs = 32;
const maxInertiaMs = 700;
const releasePauseMs = 80;
const decayMs = 120;

export function createTerminalTouchScroller(options: TerminalTouchOptions) {
  let active: (TerminalTouchPoint & { time: number; movedAt: number; velocity: number }) | null = null;
  let frame: number | null = null;
  let generation = 0;
  let disposed = false;

  function valid(point: TerminalTouchPoint) {
    return Number.isFinite(point.id) && Number.isFinite(point.x) && Number.isFinite(point.y);
  }

  function stopInertia() {
    generation++;
    if (frame !== null) options.cancelFrame(frame);
    frame = null;
  }

  function start(point: TerminalTouchPoint) {
    if (disposed || !valid(point) || (active && active.id !== point.id)) return;
    const time = options.now();
    if (!Number.isFinite(time)) return;
    stopInertia();
    active = { ...point, time, movedAt: time, velocity: 0 };
    options.onStart?.();
  }

  function moveAt(point: TerminalTouchPoint, time: number) {
    if (!active) return;
    const deltaY = active.y - point.y;
    if (!Number.isFinite(deltaY)) return;
    const elapsed = time - active.time;
    if (deltaY !== 0) {
      // Batched touch events can share a timestamp. Never turn that into an
      // infinite velocity, and cap short samples before starting inertia.
      const velocity = elapsed > 0 ? deltaY / elapsed : 0;
      active.velocity = Math.max(-maxVelocity, Math.min(maxVelocity, velocity));
      active.movedAt = time;
    }
    active.time = time;
    active.x = point.x;
    active.y = point.y;
    if (deltaY !== 0) options.onScroll(deltaY, point.x, point.y);
  }

  function move(point: TerminalTouchPoint) {
    if (disposed || !valid(point) || !active || active.id !== point.id) return;
    const time = options.now();
    if (Number.isFinite(time)) moveAt(point, time);
  }

  function end(point: TerminalTouchPoint) {
    if (disposed || !valid(point) || !active || active.id !== point.id) return;
    const { x, y } = point;
    const time = options.now();
    if (!Number.isFinite(time)) {
      cancel();
      return;
    }
    moveAt(point, time);
    if (!active) return;
    const { velocity: initialVelocity, movedAt } = active;
    active = null;
    if (time < movedAt || time - movedAt > releasePauseMs || Math.abs(initialVelocity) < minVelocity) return;

    stopInertia();
    const currentGeneration = generation;
    let previousTime = time;
    let velocity = initialVelocity;
    const animate = (nextTime: number) => {
      if (disposed || currentGeneration !== generation) return;
      frame = null;
      const elapsed = nextTime - previousTime;
      if (!Number.isFinite(nextTime) || elapsed <= 0 || nextTime - time > maxInertiaMs) return;
      // A delayed frame must not replay all the distance accumulated while the
      // browser was busy or in the background.
      const stepMs = Math.min(elapsed, maxFrameMs);
      const nextVelocity = velocity * Math.exp(-stepMs / decayMs);
      const deltaY = (velocity - nextVelocity) * decayMs;
      velocity = nextVelocity;
      previousTime = nextTime;
      if (Number.isFinite(deltaY) && deltaY !== 0) options.onScroll(deltaY, x, y);
      if (!disposed && currentGeneration === generation && nextTime - time < maxInertiaMs
        && Math.abs(velocity) >= minVelocity) {
        frame = options.requestFrame(animate);
      }
    };
    frame = options.requestFrame(animate);
  }

  function cancel() {
    stopInertia();
    active = null;
  }

  function dispose() {
    disposed = true;
    cancel();
  }

  return { start, move, end, cancel, dispose, isAnimating: () => frame !== null };
}
