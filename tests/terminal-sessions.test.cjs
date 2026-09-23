const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Terminal } = require('@xterm/headless');
const { createTerminalSessions } = require('../server/terminal-sessions.cjs');

function fixture(t, options = {}) {
  const processes = [];
  const exited = [];
  const manager = createTerminalSessions({
    shell: '/bin/sh', cwd: '/tmp', env: { TERM: 'screen', STY: 'old', TMUX: 'old', TMUX_PANE: '%1' },
    onExit: session => exited.push(session),
    spawn(shell, args, opts) {
      const child = {
        shell, args, opts, writes: [], sizes: [], killed: false, pauses: 0, resumes: 0,
        onData(callback) { child.data = callback; return { dispose() {} }; },
        onExit(callback) { child.exit = callback; return { dispose() {} }; },
        write(data) { child.writes.push(data); },
        resize(cols, rows) { child.sizes.push({ cols, rows }); },
        pause() { child.pauses++; }, resume() { child.resumes++; },
        kill() { child.killed = true; }
      };
      processes.push(child);
      return child;
    },
    ...options
  });
  t.after(() => { for (const session of manager.list()) manager.close(session.id); });
  const session = manager.create('test', { cols: 40, rows: 10 });
  return { manager, session, child: processes[0], exited };
}

function terminal(t, cols = 40, rows = 10) {
  const term = new Terminal({ cols, rows, scrollback: 10000, allowProposedApi: true });
  t.after(() => term.dispose());
  return term;
}

const write = (term, data) => new Promise(resolve => term.write(data, resolve));
function state(term) {
  const buffer = term.buffer.active;
  return {
    type: buffer.type, cursorX: buffer.cursorX, cursorY: buffer.cursorY,
    baseY: buffer.baseY, modes: { ...term.modes },
    lines: Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index).translateToString(true))
  };
}

test('terminal stream preserves native synchronized frames across chunks and disconnection', async t => {
  const { manager, session, child } = fixture(t);
  const chunks = [];
  const handle = await manager.attach(session.id, { onSnapshot() {}, onData: data => chunks.push(data) });
  const input = ['\x1b[?2026h', '\x1b[2J\x1b[H', 'footer', '\x1b[?2026l'];
  for (const data of input) child.data(data);
  await handle.resize(40, 10);
  assert.deepEqual(chunks, input);
  handle.detach();
  assert.equal(child.killed, false);
  assert.equal(manager.get(session.id).attached, false);
  assert.equal(child.opts.env.TERM, 'xterm-256color');
  assert.equal(child.opts.env.STY, undefined);
  assert.equal(child.opts.env.TMUX, undefined);
  assert.equal(child.opts.env.TMUX_PANE, undefined);
});

test('reconnect recovers scrollback, alternate buffer, modes and subsequent redraw', async t => {
  const { manager, session, child } = fixture(t);
  const original = terminal(t);
  const resumed = terminal(t);
  const history = Array.from({ length: 40 }, (_, i) => `history ${i}\r\n`).join('');
  const start = history + '\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[3;4Hhello';
  child.data(start);
  await write(original, start);
  let snapshot;
  await manager.attach(session.id, { onSnapshot: value => { snapshot = value; }, onData() {} });
  await write(resumed, snapshot.data);
  assert.deepEqual(state(resumed), state(original));
  const end = '\x1b[4;2Hnext\x1b[?1049l\r\nback';
  await write(original, end);
  await write(resumed, end);
  assert.deepEqual(state(resumed), state(original));
});

test('reconnecting inside every CSI, OSC, DCS and Unicode boundary preserves parser state', async t => {
  for (const sequence of ['\x1b[31mred\x1b[0m', '\x1b]0;a title\x07done', '\x1bP$qm\x1b\\done', '😀中文']) {
    for (let split = 1; split < sequence.length; split++) {
      const { manager, session, child } = fixture(t);
      const expected = terminal(t);
      const actual = terminal(t);
      child.data('before\r\n' + sequence.slice(0, split));
      let snapshot;
      const live = [];
      const handle = await manager.attach(session.id, { onSnapshot: value => { snapshot = value; }, onData: data => live.push(data) });
      child.data(sequence.slice(split));
      await handle.resize(40, 10);
      await write(expected, 'before\r\n' + sequence);
      await write(actual, snapshot.data);
      for (const data of live) await write(actual, data);
      assert.deepEqual(state(actual), state(expected), `${JSON.stringify(sequence)} at ${split}`);
      manager.close(session.id);
    }
  }
});

test('snapshot inside an active synchronized frame retains the native mode', async t => {
  const { manager, session, child } = fixture(t);
  child.data('\x1b[?2026h\x1b[2J\x1b[Hpartial');
  let snapshot;
  await manager.attach(session.id, { onSnapshot: value => { snapshot = value; }, onData() {} });
  const resumed = terminal(t);
  await write(resumed, snapshot.data);
  assert.equal(resumed.modes.synchronizedOutputMode, true);
  await write(resumed, ' finished\x1b[?2026l');
  assert.equal(resumed.modes.synchronizedOutputMode, false);
  assert.equal(resumed.buffer.active.getLine(0).translateToString(true), 'partial finished');
});

test('force takeover revokes previous input/resize/detach without terminating the process', async t => {
  const { manager, session, child } = fixture(t);
  const reasons = [];
  const first = await manager.attach(session.id, { onSnapshot() {}, onData() {}, onDetach: reason => reasons.push(reason) });
  await assert.rejects(manager.attach(session.id, { onSnapshot() {}, onData() {} }), { code: 'ATTACHED' });
  const second = await manager.attach(session.id, { force: true, onSnapshot() {}, onData() {} });
  first.write('wrong');
  await first.resize(50, 12);
  first.detach();
  second.write('right');
  await second.resize(50, 12);
  await second.resize(50, 12);
  assert.deepEqual(reasons, ['taken-over']);
  assert.deepEqual(child.writes, ['right']);
  assert.deepEqual(child.sizes, [{ cols: 50, rows: 12 }]);
  assert.equal(manager.get(session.id).attached, true);
  assert.equal(child.killed, false);
});

test('unattached terminal answers position queries and attached terminal leaves replies to browser', async t => {
  const { manager, session, child } = fixture(t);
  child.data('\x1b[4;7H\x1b[6n');
  const handle = await manager.attach(session.id, { onSnapshot() {}, onData() {} });
  assert.deepEqual(child.writes, ['\x1b[4;7R']);
  child.data('\x1b[6n');
  await handle.resize(40, 10);
  assert.deepEqual(child.writes, ['\x1b[4;7R']);
});

test('large incomplete controls bound retained data and recover when their terminator arrives', async t => {
  const { manager, session, child } = fixture(t);
  child.data('\x1b]0;' + 'x'.repeat(300 * 1024));
  await assert.rejects(manager.attach(session.id, { onSnapshot() {}, onData() {} }), { code: 'SNAPSHOT_PENDING' });
  child.data('\x07recovered');
  let snapshot;
  await manager.attach(session.id, { onSnapshot: value => { snapshot = value; }, onData() {} });
  assert.ok(snapshot.data.length < 1024);
  const resumed = terminal(t);
  await write(resumed, snapshot.data);
  assert.equal(resumed.buffer.active.getLine(0).translateToString(true), 'recovered');
});

test('snapshots restore cursor after scroll-region and origin-mode commands', async t => {
  const { manager, session, child } = fixture(t);
  const data = '\x1b[2;8r\x1b[?6h\x1b[3;5Hregion';
  child.data(data);
  let snapshot;
  await manager.attach(session.id, { onSnapshot: value => { snapshot = value; }, onData() {} });
  const expected = terminal(t);
  const resumed = terminal(t);
  await write(expected, data);
  await write(resumed, snapshot.data);
  await write(expected, '!\r\nnext');
  await write(resumed, '!\r\nnext');
  assert.deepEqual(state(resumed), state(expected));
});

test('snapshot preserves pending wrap, including a wide character in the final column', async t => {
  for (const data of ['x'.repeat(40), 'x'.repeat(38) + '中']) {
    const { manager, session, child } = fixture(t);
    child.data(data);
    let snapshot;
    await manager.attach(session.id, { onSnapshot: value => { snapshot = value; }, onData() {} });
    const expected = terminal(t);
    const resumed = terminal(t);
    await write(expected, data);
    await write(resumed, snapshot.data);
    await write(expected, 'next');
    await write(resumed, 'next');
    assert.deepEqual(state(resumed), state(expected));
  }
});

test('snapshot preserves saved cursor, its attributes and line drawing charset', async t => {
  const { manager, session, child } = fixture(t);
  const data = '\x1b[3;5H\x1b[31m\x1b(0\x1b7\x1b(B\x1b[0m\x1b[6;1Hcurrent';
  child.data(data);
  let snapshot;
  await manager.attach(session.id, { onSnapshot: value => { snapshot = value; }, onData() {} });
  const expected = terminal(t);
  const resumed = terminal(t);
  await write(expected, data);
  await write(resumed, snapshot.data);
  await write(expected, '\x1b8qq');
  await write(resumed, '\x1b8qq');
  assert.deepEqual(state(resumed), state(expected));
  assert.equal(resumed.buffer.active.getLine(2).getCell(4).getFgColor(), expected.buffer.active.getLine(2).getCell(4).getFgColor());
});

test('snapshot preserves a saved cursor waiting to wrap and its origin mode', async t => {
  for (const data of ['x'.repeat(40) + '\x1b7\x1b[4;1Hbelow', '\x1b[2;8r\x1b[?6h\x1b[3;2H\x1b7\x1b[?6l\x1b[6;1Hbelow']) {
    const { manager, session, child } = fixture(t);
    child.data(data);
    let snapshot;
    await manager.attach(session.id, { onSnapshot: value => { snapshot = value; }, onData() {} });
    const expected = terminal(t);
    const resumed = terminal(t);
    await write(expected, data);
    await write(resumed, snapshot.data);
    await write(expected, '\x1b8next');
    await write(resumed, '\x1b8next');
    assert.deepEqual(state(resumed), state(expected));
  }
});

test('close during queued output settles pending work and removes session', async t => {
  const { manager, session, child, exited } = fixture(t);
  const handle = await manager.attach(session.id, { onSnapshot() {}, onData() {} });
  child.data('data');
  const resizing = handle.resize(41, 10);
  await manager.close(session.id);
  await resizing;
  assert.equal(manager.get(session.id), null);
  assert.equal(child.killed, true);
  assert.equal(exited.length, 1);
});
