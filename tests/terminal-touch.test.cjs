const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const browserModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve('../src/terminal-touch.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS }
}).outputText, { exports: browserModule.exports });
const { createTerminalTouchScroller } = browserModule.exports;

function fixture() {
  let now = 0;
  let nextId = 0;
  let starts = 0;
  const frames = new Map();
  const canceledCallbacks = [];
  const scrolls = [];
  const scroller = createTerminalTouchScroller({
    onScroll: (deltaY, x, y) => scrolls.push({ deltaY, x, y }),
    onStart: () => starts++,
    now: () => now,
    requestFrame(callback) {
      const id = nextId++;
      frames.set(id, callback);
      return id;
    },
    cancelFrame(id) {
      const callback = frames.get(id);
      if (callback) canceledCallbacks.push(callback);
      frames.delete(id);
    }
  });
  return {
    scroller, scrolls, canceledCallbacks,
    advance: ms => { now += ms; },
    setTime: time => { now = time; },
    pending: () => frames.size,
    starts: () => starts,
    renderFrame(ms = 16) {
      now += ms;
      for (const [id, callback] of [...frames]) {
        frames.delete(id);
        callback(now);
      }
    }
  };
}

const point = (y, id = 1, x = 40) => ({ id, x, y });

function fling(f, interval = 16) {
  f.scroller.start(point(100));
  f.advance(interval);
  f.scroller.move(point(40));
  f.scroller.end(point(40));
}

test('same-timestamp touches scroll only the finger distance without starting inertia', () => {
  const f = fixture();
  fling(f, 0);
  assert.deepEqual(f.scrolls, [{ deltaY: 60, x: 40, y: 40 }]);
  assert.equal(f.pending(), 0);
});

test('a one-millisecond fling has bounded velocity, distance, and animation lifetime', () => {
  const f = fixture();
  fling(f, 1);
  let rendered = 0;
  while (f.pending() && rendered < 100) {
    f.renderFrame();
    rendered++;
  }
  assert.equal(f.pending(), 0);
  assert.ok(rendered <= 45);
  const inertia = f.scrolls.slice(1);
  assert.ok(inertia.length > 0);
  assert.ok(inertia.every(({ deltaY }) => Number.isFinite(deltaY) && deltaY > 0 && deltaY <= 80));
  assert.ok(inertia.reduce((sum, { deltaY }) => sum + deltaY, 0) <= 300);
});

test('reversing a drag changes direction and keeps the release coordinates', () => {
  const f = fixture();
  f.scroller.start(point(100));
  f.advance(20);
  f.scroller.move(point(40));
  f.advance(20);
  f.scroller.end(point(60, 1, 55));
  f.renderFrame();
  assert.equal(f.scrolls[0].deltaY, 60);
  assert.equal(f.scrolls[1].deltaY, -20);
  assert.ok(f.scrolls[2].deltaY < 0);
  assert.equal(f.scrolls[2].x, 55);
  assert.equal(f.scrolls[2].y, 60);
});

test('a new touch or cancellation stops inertia even if an old frame is delivered', () => {
  for (const action of ['start', 'cancel']) {
    const f = fixture();
    fling(f);
    assert.equal(f.pending(), 1);
    assert.equal(f.scroller.isAnimating(), true);
    if (action === 'start') f.scroller.start(point(90, 2));
    else f.scroller.cancel();
    assert.equal(f.pending(), 0);
    assert.equal(f.scroller.isAnimating(), false);
    const count = f.scrolls.length;
    for (const callback of f.canceledCallbacks) callback(32);
    assert.equal(f.scrolls.length, count);
    assert.equal(f.pending(), 0);
    if (action === 'start') assert.equal(f.starts(), 2);
  }
});

test('another finger cannot replace, move, or end the tracked touch', () => {
  const f = fixture();
  f.scroller.start(point(100));
  f.scroller.start(point(200, 2));
  f.advance(20);
  f.scroller.move(point(-500, 2));
  f.scroller.end(point(-500, 2));
  assert.deepEqual(f.scrolls, []);
  assert.equal(f.starts(), 1);
  f.scroller.move(point(80));
  assert.deepEqual(f.scrolls, [{ deltaY: 20, x: 40, y: 80 }]);
  f.scroller.cancel();
});

test('pausing for more than 80ms before release does not start inertia', () => {
  const f = fixture();
  f.scroller.start(point(100));
  f.advance(16);
  f.scroller.move(point(40));
  f.advance(81);
  f.scroller.end(point(40));
  assert.equal(f.pending(), 0);
  assert.equal(f.scrolls.length, 1);
});

test('delayed frames are capped and inertia expires after a long frame gap', () => {
  const f = fixture();
  fling(f, 1);
  f.renderFrame(400);
  assert.ok(f.scrolls.at(-1).deltaY <= 80);
  const count = f.scrolls.length;
  f.renderFrame(301);
  assert.equal(f.pending(), 0);
  assert.equal(f.scrolls.length, count);
});

test('invalid coordinates and timestamps never produce invalid scroll output', () => {
  const f = fixture();
  f.scroller.start(point(Infinity));
  assert.equal(f.starts(), 0);
  f.scroller.start(point(100));
  f.scroller.move(point(NaN));
  f.scroller.move(point(40, NaN));
  f.setTime(NaN);
  f.scroller.move(point(40));
  f.scroller.end(point(40));
  assert.deepEqual(f.scrolls, []);
  assert.equal(f.pending(), 0);
  f.setTime(0);
  fling(f);
  f.renderFrame(Infinity);
  assert.equal(f.pending(), 0);
  assert.ok(f.scrolls.every(scroll => Object.values(scroll).every(Number.isFinite)));
});

test('non-increasing timestamps cannot create inertia or an animation loop', () => {
  const f = fixture();
  f.setTime(100);
  fling(f, -1);
  assert.equal(f.pending(), 0);
  f.setTime(0);
  fling(f);
  f.renderFrame(0);
  assert.equal(f.pending(), 0);
});

test('disposal stops work and prevents further starts, motion, or queued callbacks', () => {
  const f = fixture();
  fling(f);
  f.scroller.dispose();
  f.scroller.dispose();
  assert.equal(f.pending(), 0);
  const count = f.scrolls.length;
  for (const callback of f.canceledCallbacks) callback(32);
  fling(f);
  f.renderFrame();
  assert.equal(f.scrolls.length, count);
  assert.equal(f.pending(), 0);
  assert.equal(f.starts(), 1);
});
