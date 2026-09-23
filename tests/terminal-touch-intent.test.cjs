const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const browserModule = { exports: {} };
const browserSource = ts.transpileModule(fs.readFileSync(require.resolve('../src/terminal-touch-intent.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS }
}).outputText;
vm.runInNewContext(browserSource, { exports: browserModule.exports });
const { createTerminalTouchIntent } = browserModule.exports;

function harness() {
  let time = 100;
  return {
    intent: createTerminalTouchIntent(() => time),
    setTime(value) { time = value; },
    advance(ms) { time += ms; }
  };
}

const origin = { id: 7, x: 100, y: 200 };

test('a short stationary tap requests input once, including small release-coordinate jitter', () => {
  const app = harness();
  app.intent.start(origin, false);
  app.advance(150);
  const endPoint = { ...origin, x: 102, y: 202 };
  assert.equal(app.intent.end(endPoint), true);
  assert.equal(app.intent.end(endPoint), false);
});

test('a short scroll cannot request input even if only its final changedTouch shows movement', () => {
  const app = harness();
  for (const endPoint of [{ ...origin, y: 206 }, { ...origin, x: 106 }, { ...origin, x: 103, y: 201 }]) {
    app.intent.start(origin, false);
    app.advance(50);
    assert.equal(app.intent.end(endPoint), false);
  }
});

test('any touchmove cancels input intent, including tiny movements and a return to the origin', () => {
  const app = harness();
  for (const movePoint of [origin, { ...origin, x: 101 }, { ...origin, y: 240 }]) {
    app.intent.start(origin, false);
    app.intent.move(movePoint);
    app.advance(60);
    assert.equal(app.intent.end(origin), false);
  }
});

test('tapping to stop momentum stays in browsing mode and the following independent tap can type', () => {
  const app = harness();
  app.intent.start(origin, true);
  app.advance(100);
  assert.equal(app.intent.end(origin), false);

  app.intent.start(origin, false);
  app.advance(100);
  assert.equal(app.intent.end(origin), true);
});

test('long presses do not focus, while taps at the duration limits remain valid', () => {
  const app = harness();
  for (const [duration, expected] of [[0, true], [350, true], [351, false], [1_000, false]]) {
    app.intent.start(origin, false);
    app.advance(duration);
    assert.equal(app.intent.end(origin), expected, `${duration}ms`);
  }
});

test('multi-finger cancellation and mismatched touch identifiers cannot focus or leak into a new gesture', () => {
  const app = harness();
  app.intent.start(origin, false);
  app.intent.cancel();
  assert.equal(app.intent.end(origin), false);

  app.intent.start(origin, false);
  assert.equal(app.intent.end({ ...origin, id: 8 }), false);
  assert.equal(app.intent.end(origin), false);

  app.intent.start(origin, false);
  app.intent.move({ ...origin, id: 8 });
  assert.equal(app.intent.end(origin), false);

  app.intent.start(origin, false);
  app.advance(80);
  assert.equal(app.intent.end(origin), true);
});

test('invalid coordinates, identifiers, and timestamps never request input', () => {
  const app = harness();
  for (const invalidPoint of [
    { ...origin, x: NaN }, { ...origin, y: Infinity }, { ...origin, id: NaN }, { ...origin, id: 1.5 }
  ]) {
    app.intent.start(invalidPoint, false);
    assert.equal(app.intent.end(origin), false);
    app.intent.start(origin, false);
    assert.equal(app.intent.end(invalidPoint), false);
  }

  for (const invalidTime of [NaN, Infinity, -Infinity]) {
    app.setTime(invalidTime);
    app.intent.start(origin, false);
    app.setTime(100);
    assert.equal(app.intent.end(origin), false);

    app.intent.start(origin, false);
    app.setTime(invalidTime);
    assert.equal(app.intent.end(origin), false);
  }
  app.setTime(100);
  app.intent.start(origin, false);
  app.setTime(99);
  assert.equal(app.intent.end(origin), false);
});
