const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const browserModule = { exports: {} };
const browserSource = ts.transpileModule(fs.readFileSync(require.resolve('../src/terminal-fit.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS }
}).outputText;
vm.runInNewContext(browserSource, { exports: browserModule.exports });
const { createTerminalFitScheduler } = browserModule.exports;

function fakeTiming() {
  let now = 0;
  let nextId = 0;
  const frames = new Map();
  const timers = new Map();
  return {
    timing: {
      requestFrame(callback) {
        const id = nextId++;
        frames.set(id, callback);
        return id;
      },
      cancelFrame: id => frames.delete(id),
      setTimer(callback, delay) {
        const id = nextId++;
        timers.set(id, { callback, due: now + delay });
        return id;
      },
      clearTimer: id => timers.delete(id)
    },
    advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.due <= end)
          .sort((a, b) => a[1].due - b[1].due)[0];
        if (!next) break;
        const [id, timer] = next;
        now = timer.due;
        timers.delete(id);
        timer.callback();
      }
      now = end;
    },
    renderFrame() {
      for (const id of [...frames.keys()]) {
        const callback = frames.get(id);
        frames.delete(id);
        callback?.();
      }
    },
    pending: () => ({ frames: frames.size, timers: timers.size })
  };
}

test('keyboard animation fits only the final viewport after it settles', () => {
  const clock = fakeTiming();
  const fittedRows = [];
  let rows = 42;
  const scheduler = createTerminalFitScheduler(() => fittedRows.push(rows), clock.timing);

  // A frame queued before the keyboard appears must also wait for it to settle.
  scheduler.request();
  for (const nextRows of [38, 31, 24, 18]) {
    rows = nextRows;
    scheduler.request(120);
    clock.advance(30);
    clock.renderFrame();
    assert.deepEqual(fittedRows, []);
  }

  clock.advance(89);
  clock.renderFrame();
  assert.deepEqual(fittedRows, []);
  clock.advance(1);
  assert.deepEqual(fittedRows, []);
  clock.renderFrame();
  assert.deepEqual(fittedRows, [18]);
  assert.deepEqual(clock.pending(), { frames: 0, timers: 0 });
});

test('observer requests and immediate flush cannot bypass viewport settling', () => {
  const clock = fakeTiming();
  let fits = 0;
  const scheduler = createTerminalFitScheduler(() => fits++, clock.timing);
  scheduler.request(120);

  for (let elapsed = 0; elapsed < 100; elapsed += 20) {
    clock.advance(20);
    scheduler.request();
    scheduler.flush();
    clock.renderFrame();
    assert.equal(fits, 0);
  }

  // Observer calls also must not extend the viewport's quiet period.
  clock.advance(20);
  clock.renderFrame();
  assert.equal(fits, 1);
});

test('desktop requests coalesce into one frame and flush cancels a queued frame', () => {
  const clock = fakeTiming();
  let fits = 0;
  const scheduler = createTerminalFitScheduler(() => fits++, clock.timing);

  scheduler.request();
  scheduler.request();
  scheduler.request();
  assert.deepEqual(clock.pending(), { frames: 1, timers: 0 });
  assert.equal(fits, 0);
  clock.renderFrame();
  assert.equal(fits, 1);

  scheduler.request();
  scheduler.flush();
  assert.equal(fits, 2);
  clock.renderFrame();
  assert.equal(fits, 2);
  scheduler.flush();
  assert.equal(fits, 3);
});

test('a renewed viewport animation cancels the fit queued when an earlier one settled', () => {
  const clock = fakeTiming();
  let fits = 0;
  const scheduler = createTerminalFitScheduler(() => fits++, clock.timing);

  scheduler.request(120);
  clock.advance(120);
  scheduler.request(120);
  clock.renderFrame();
  assert.equal(fits, 0);
  clock.advance(120);
  clock.renderFrame();
  assert.equal(fits, 1);
});

test('disposal cancels pending work and prevents subsequent requests or flushes', () => {
  for (const pending of ['frame', 'timer', 'settled frame']) {
    const clock = fakeTiming();
    let fits = 0;
    const scheduler = createTerminalFitScheduler(() => fits++, clock.timing);
    if (pending === 'frame') {
      scheduler.request();
    } else {
      scheduler.request(120);
      if (pending === 'settled frame') clock.advance(120);
    }

    scheduler.dispose();
    scheduler.dispose();
    assert.deepEqual(clock.pending(), { frames: 0, timers: 0 });
    scheduler.request();
    scheduler.request(120);
    scheduler.flush();
    clock.advance(1000);
    clock.renderFrame();
    assert.equal(fits, 0, pending);
    assert.deepEqual(clock.pending(), { frames: 0, timers: 0 });
  }
});
