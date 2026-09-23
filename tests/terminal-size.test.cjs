const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const browserModule = { exports: {} };
const browserSource = ts.transpileModule(fs.readFileSync(require.resolve('../src/terminal-size.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS }
}).outputText;
vm.runInNewContext(browserSource, { exports: browserModule.exports });
const browserSize = (...args) => ({ ...browserModule.exports.normalizeTerminalSize(...args) });
const { normalizeTerminalSize: serverSize } = require('../server/terminal-size.cjs');

test('browser and PTY keep identical dimensions for normal, large, and tiny viewports', () => {
  const cases = [
    [[120, 32], { cols: 120, rows: 32 }],
    [[384, 160], { cols: 300, rows: 120 }],
    [[2, 1], { cols: 20, rows: 6 }],
    [[99.9, 40.8], { cols: 99, rows: 40 }],
    [['240', '80'], { cols: 240, rows: 80 }]
  ];
  for (const [input, expected] of cases) {
    const browser = browserSize(...input);
    assert.deepEqual(browser, expected);
    assert.deepEqual(serverSize(...input), browser);
    assert.deepEqual(serverSize(browser.cols, browser.rows), browser);
  }
});

test('malformed sizes always normalize to finite integer defaults on both sides', () => {
  for (const value of [undefined, null, NaN, Infinity, -Infinity, 0, -1, '', 'invalid', {}, []]) {
    const expected = { cols: 120, rows: 32 };
    assert.deepEqual(browserSize(value, value), expected);
    assert.deepEqual(serverSize(value, value), expected);
  }
});
