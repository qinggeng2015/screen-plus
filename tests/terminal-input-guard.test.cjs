const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

const browserSource = ts.transpileModule(fs.readFileSync(require.resolve('../src/terminal-input-guard.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS }
}).outputText;

function harness() {
  let now = 0;
  const browserModule = { exports: {} };
  vm.runInNewContext(browserSource, { exports: browserModule.exports, Date: { now: () => now } });
  const host = new EventTarget();
  const guard = browserModule.exports.bindTerminalInputGuard(host);
  const received = [];
  for (const type of ['pointerdown', 'touchstart', 'mousedown', 'click', 'contextmenu', 'wheel', 'keydown']) {
    host.addEventListener(type, () => received.push(type));
  }
  return {
    guard,
    received,
    advance(ms) { now += ms; },
    dispatch(type, fields = {}) {
      const event = new Event(type, { cancelable: true });
      Object.assign(event, fields);
      host.dispatchEvent(event);
      return event;
    }
  };
}

test('mouse focus and selection events remain usable before and after touch input', () => {
  const app = harness();
  app.dispatch('pointerdown', { pointerType: 'mouse' });
  assert.equal(app.dispatch('mousedown').defaultPrevented, false);
  assert.equal(app.dispatch('click').defaultPrevented, false);
  assert.equal(app.dispatch('contextmenu').defaultPrevented, false);

  app.dispatch('touchstart');
  app.dispatch('pointerdown', { pointerType: 'mouse' });
  assert.equal(app.dispatch('mousedown').defaultPrevented, false);
  assert.equal(app.dispatch('click').defaultPrevented, false);
  assert.equal(app.received.filter(type => type === 'mousedown').length, 2);
});

test('touch mouse events cannot focus xterm after any delay, while scrolling and typing pass through', () => {
  const app = harness();
  app.dispatch('pointerdown', { pointerType: 'touch' });
  app.dispatch('touchstart');
  app.advance(60_000);

  for (const type of ['mousedown', 'click', 'contextmenu']) {
    assert.equal(app.dispatch(type).defaultPrevented, true, type);
    assert.equal(app.received.includes(type), false, `${type} reached xterm`);
  }
  assert.equal(app.dispatch('wheel').defaultPrevented, false);
  assert.equal(app.dispatch('keydown').defaultPrevented, false);
  assert.deepEqual(app.received, ['pointerdown', 'touchstart', 'wheel', 'keydown']);
});

test('touch origin overrides misleading mouse pointer type, including after a real mouse event', () => {
  const app = harness();
  app.dispatch('pointerdown', { pointerType: 'mouse' });
  assert.equal(app.dispatch('mousedown', {
    pointerType: 'mouse', sourceCapabilities: { firesTouchEvents: true }
  }).defaultPrevented, true);

  app.dispatch('touchstart');
  app.dispatch('pointerdown', {
    pointerType: 'mouse', sourceCapabilities: { firesTouchEvents: true }
  });
  assert.equal(app.dispatch('mousedown').defaultPrevented, true);
  assert.equal(app.received.includes('mousedown'), false);
});

test('explicit non-touch mouse capabilities release old touch fallback without a pointerdown', () => {
  const app = harness();
  app.dispatch('touchstart');
  assert.equal(app.dispatch('mousedown', {
    sourceCapabilities: { firesTouchEvents: false }
  }).defaultPrevented, false);
  assert.equal(app.dispatch('click').defaultPrevented, false);
  assert.deepEqual(app.received, ['touchstart', 'mousedown', 'click']);
});

test('pen input cannot focus the hidden textarea, and a subsequent mouse pointer restores selection', () => {
  const app = harness();
  app.dispatch('pointerdown', { pointerType: 'pen' });
  assert.equal(app.dispatch('mousedown', {
    sourceCapabilities: { firesTouchEvents: false }
  }).defaultPrevented, true);
  assert.equal(app.dispatch('click', { pointerType: 'pen' }).defaultPrevented, true);
  app.dispatch('pointerdown', { pointerType: 'mouse' });
  assert.equal(app.dispatch('mousedown').defaultPrevented, false);
});

test('disposal removes all focus guards and origin listeners', () => {
  const app = harness();
  app.dispatch('touchstart');
  app.guard.dispose();
  app.guard.dispose();
  for (const type of ['mousedown', 'click', 'contextmenu']) {
    assert.equal(app.dispatch(type).defaultPrevented, false, type);
    assert.equal(app.received.includes(type), true, type);
  }
});
