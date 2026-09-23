const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { Terminal } = require('@xterm/xterm');

const browserModule = { exports: {} };
const browserSource = ts.transpileModule(fs.readFileSync(require.resolve('../src/terminal-write.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS }
}).outputText;
vm.runInNewContext(browserSource, { exports: browserModule.exports, queueMicrotask });
const { writeTerminal } = browserModule.exports;

function terminal(t, size) {
  // Use the actual browser terminal write/resize implementation. Its buffer is
  // available without opening a DOM renderer, including the resize flush queue.
  const term = new Terminal({ ...size, allowProposedApi: true });
  t.after(() => term.dispose());
  return term;
}

function completedWrite(operation) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Terminal write callback did not complete')), 1000);
    operation(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

const firstLine = term => term.buffer.active.getLine(0).translateToString(true);

for (const [name, viewport, snapshot] of [
  ['same dimensions', { cols: 80, rows: 24 }, { cols: 80, rows: 24 }],
  ['desktop session on a phone', { cols: 40, rows: 30 }, { cols: 120, rows: 40 }],
  ['phone session on a desktop', { cols: 120, rows: 40 }, { cols: 40, rows: 30 }]
]) {
  test(`snapshot restore completes and accepts live output: ${name}`, async t => {
    const term = terminal(t, viewport);
    const calls = { drained: 0, snapshot: 0, restored: 0 };
    await completedWrite(done => {
      writeTerminal(term, '', () => {
        calls.drained++;
        term.reset();
        term.clear();
        term.resize(snapshot.cols, snapshot.rows);
        writeTerminal(term, 'restored prompt', () => {
          calls.snapshot++;
          // Output arriving during replay must use the snapshot's dimensions.
          term.write(new Uint8Array(Buffer.from(' + buffered')));
          writeTerminal(term, '', () => {
            calls.restored++;
            term.resize(viewport.cols, viewport.rows);
            writeTerminal(term, ' + live', done);
          });
        });
      });
    });

    assert.deepEqual(calls, { drained: 1, snapshot: 1, restored: 1 });
    assert.equal(firstLine(term), 'restored prompt + buffered + live');
    assert.equal(term.cols, viewport.cols);
    assert.equal(term.rows, viewport.rows);
  });
}

test('fitting after a nonempty write does not replay its data or lose the following write', async t => {
  const term = terminal(t, { cols: 120, rows: 40 });
  let callbacks = 0;
  let restoring = true;
  await completedWrite(done => {
    writeTerminal(term, new Uint8Array(Buffer.from('snapshot')), () => {
      callbacks++;
      // Match the restoration guard: it prevents recursive fitting but cannot
      // prevent xterm from parsing the old chunk twice if resize reenters it.
      if (!restoring) return;
      restoring = false;
      term.resize(40, 30);
      writeTerminal(term, ' + live', done);
    });
  });

  assert.equal(callbacks, 1);
  assert.equal(firstLine(term), 'snapshot + live');
});
