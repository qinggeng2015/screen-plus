const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { Terminal } = require('@xterm/xterm');

const browserModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve('../src/terminal-scroll.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS }
}).outputText, { exports: browserModule.exports });
const { createTerminalScrollHandler } = browserModule.exports;

function fixture(t) {
  const terminal = new Terminal({ cols: 40, rows: 5, scrollback: 100 });
  t.after(() => terminal.dispose());
  const localScrolls = [];
  const wheels = [];
  let cellHeight = 20;
  // The real browser terminal parses mode changes and moves its scrollback
  // without a DOM; only rendered cell dimensions need an isolated stand-in.
  const handler = createTerminalScrollHandler({
    get buffer() { return terminal.buffer; },
    get modes() { return terminal.modes; },
    get dimensions() { return cellHeight === undefined ? undefined : { css: { cell: { height: cellHeight } } }; },
    scrollLines(lines) {
      localScrolls.push(lines);
      terminal.scrollLines(lines);
    }
  }, (lines, x, y) => wheels.push({ lines, x, y }));
  return {
    terminal, handler, localScrolls, wheels,
    setCellHeight: value => { cellHeight = value; },
    write: data => new Promise(resolve => terminal.write(data, resolve))
  };
}

test('normal terminal history scrolls locally through the public API', async t => {
  const f = fixture(t);
  await f.write(Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\r\n'));
  const base = f.terminal.buffer.active.baseY;
  assert.ok(base > 2);
  f.handler.scroll(-40, 12, 34);
  assert.equal(f.terminal.buffer.active.viewportY, base - 2);
  f.handler.scroll(20, 12, 34);
  assert.equal(f.terminal.buffer.active.viewportY, base - 1);
  assert.deepEqual(f.localScrolls, [-2, 1]);
  assert.deepEqual(f.wheels, []);
});

test('alternate-buffer scrolling is routed to application wheel handling', async t => {
  const f = fixture(t);
  await f.write('\x1b[?1049h');
  assert.equal(f.terminal.buffer.active.type, 'alternate');
  f.handler.scroll(-40, 15, 25);
  assert.deepEqual(f.wheels, [{ lines: -2, x: 15, y: 25 }]);
  assert.deepEqual(f.localScrolls, []);
  await f.write('\x1b[?1049l');
  f.handler.scroll(20, 15, 25);
  assert.equal(f.terminal.buffer.active.type, 'normal');
  assert.deepEqual(f.localScrolls, [1]);
});

test('VT200, drag, and any-motion protocols route normal-buffer gestures to the app', async t => {
  const f = fixture(t);
  for (const [code, mode] of [[1000, 'vt200'], [1002, 'drag'], [1003, 'any']]) {
    await f.write(`\x1b[?${code}h\x1b[?1006h`);
    assert.equal(f.terminal.modes.mouseTrackingMode, mode);
    assert.equal(f.terminal.buffer.active.type, 'normal');
    f.handler.scroll(40, 10, 30);
    await f.write(`\x1b[?${code}l`);
  }
  assert.deepEqual(f.wheels, Array.from({ length: 3 }, () => ({ lines: 2, x: 10, y: 30 })));
  assert.deepEqual(f.localScrolls, []);
  f.handler.scroll(-20, 10, 30);
  assert.deepEqual(f.localScrolls, [-1]);
});

test('X10 keeps normal scrollback local and allows alternate-buffer key fallback', async t => {
  const f = fixture(t);
  await f.write('\x1b[?9h');
  assert.equal(f.terminal.modes.mouseTrackingMode, 'x10');
  f.handler.scroll(-20, 10, 30);
  assert.deepEqual(f.localScrolls, [-1]);
  assert.deepEqual(f.wheels, []);
  await f.write('\x1b[?1049h');
  f.handler.scroll(20, 10, 30);
  assert.deepEqual(f.wheels, [{ lines: 1, x: 10, y: 30 }]);
});

test('fractional pixels accumulate in both directions and reset at a new gesture', t => {
  const f = fixture(t);
  for (const delta of [7, 8, 4]) f.handler.scroll(delta, 1, 2);
  assert.deepEqual(f.localScrolls, []);
  f.handler.scroll(6, 1, 2);
  assert.deepEqual(f.localScrolls, [1]);
  f.handler.scroll(-24, 1, 2);
  assert.deepEqual(f.localScrolls, [1]);
  f.handler.scroll(-1, 1, 2);
  assert.deepEqual(f.localScrolls, [1, -1]);
  f.handler.scroll(19, 1, 2);
  f.handler.reset();
  f.handler.scroll(1, 1, 2);
  assert.deepEqual(f.localScrolls, [1, -1]);
});

test('buffer and tracking-mode changes cannot carry fractional motion across contexts', async t => {
  const f = fixture(t);
  f.handler.scroll(19, 1, 2);
  await f.write('\x1b[?1049h');
  f.handler.scroll(1, 1, 2);
  assert.deepEqual(f.wheels, []);
  f.handler.scroll(18, 1, 2);
  await f.write('\x1b[?1049l');
  f.handler.scroll(1, 1, 2);
  assert.deepEqual(f.localScrolls, []);
  f.handler.scroll(18, 1, 2);
  await f.write('\x1b[?1000h');
  f.handler.scroll(1, 1, 2);
  assert.deepEqual(f.wheels, []);
  f.handler.scroll(19, 1, 2);
  assert.deepEqual(f.wheels, [{ lines: 1, x: 1, y: 2 }]);
});

test('missing dimensions, invalid data, and arithmetic overflow do not reach either sink', t => {
  const f = fixture(t);
  for (const delta of [NaN, Infinity, -Infinity, Number.MAX_VALUE]) f.handler.scroll(delta, 1, 2);
  f.handler.scroll(20, NaN, 2);
  f.handler.scroll(20, 1, Infinity);
  for (const height of [undefined, 0, -20, NaN, Infinity]) {
    f.setCellHeight(height);
    f.handler.scroll(20, 1, 2);
  }
  assert.deepEqual(f.localScrolls, []);
  assert.deepEqual(f.wheels, []);
  f.setCellHeight(20);
  f.handler.scroll(19, 1, 2);
  f.setCellHeight(10);
  f.handler.scroll(1, 1, 2);
  assert.deepEqual(f.localScrolls, []);
  f.handler.scroll(9, 1, 2);
  assert.deepEqual(f.localScrolls, [1]);
});
