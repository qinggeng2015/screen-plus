const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Terminal } = require('@xterm/xterm');
const { createTerminalOutput } = require('../server/terminal-output.cjs');
const fixture = require('./fixtures/screen-redraw.json');

const BEGIN = '\x1b[?2026h';
const END = '\x1b[?2026l';
const unwrap = value => value.replaceAll(BEGIN, '').replaceAll(END, '');

function harness(options = {}) {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  const messages = [];
  const output = createTerminalOutput({
    send: data => messages.push({ atMs: now, data }),
    setTimeout(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, atMs: now + delay });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    ...options
  });
  return {
    output,
    messages,
    advance(until) {
      while (true) {
        const entry = [...timers].sort((a, b) => a[1].atMs - b[1].atMs)[0];
        if (!entry || entry[1].atMs > until) break;
        timers.delete(entry[0]);
        now = entry[1].atMs;
        entry[1].callback();
      }
      now = until;
    }
  };
}

async function terminalState(chunks, cols = fixture.cols, rows = fixture.rows) {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 1000 });
  try {
    for (const data of chunks) await new Promise(resolve => terminal.write(data, resolve));
    const buffer = terminal.buffer.active;
    return {
      lines: Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i).translateToString(true)),
      cursor: [buffer.cursorX, buffer.cursorY],
      history: buffer.baseY
    };
  } finally {
    terminal.dispose();
  }
}

test('real Screen 4.9 footer clear/redraw pairs arrive as synchronized batches', async () => {
  const { output, messages, advance } = harness();
  for (const chunk of fixture.chunks) {
    advance(chunk.atMs);
    output.push(chunk.data);
  }
  advance(2000);
  const clears = messages.filter(({ data }) => data.includes('\x1b[2A\x1b[J'));
  assert.equal(clears.length, 10);
  for (const { data } of clears) {
    assert.ok(data.startsWith(BEGIN));
    assert.ok(data.endsWith(END));
    assert.ok(data.includes('PROMPT enter request'));
    assert.ok(data.includes('PROMPT footer'));
  }
  assert.equal(unwrap(messages.map(m => m.data).join('')), fixture.chunks.map(m => m.data).join(''));
  const raw = await terminalState(fixture.chunks.map(m => m.data));
  const protectedState = await terminalState(messages.map(m => m.data));
  assert.deepEqual(protectedState, raw);
  assert.equal(protectedState.history, 0);
  assert.deepEqual(protectedState.lines.slice(-3), fixture.expectedFooter);
});

test('split CSI, OSC, DCS, ST, charset escapes, and Unicode are never interrupted', async () => {
  const samples = [
    '\x1b[2;4Hhello', '\x1b]0;title\x07hello', '\x1b]0;title\x1b\\hello',
    '\x1bPpayload\x1b\\hello', '\x1b(0abc\x1b(Bhello', '\x1b(\u005bhello',
    '\x9b2;4Hhello', '\x9dtitle\x9chello', '你好🙂world'
  ];
  for (const sample of samples) {
    for (let split = 1; split < sample.length; split += 1) {
      const { output, messages, advance } = harness();
      output.push(sample.slice(0, split));
      advance(100);
      output.push(sample.slice(split));
      advance(200);
      const joined = messages.map(m => m.data).join('');
      assert.equal(unwrap(joined), sample);
      assert.deepEqual(await terminalState([joined]), await terminalState([sample]));
      for (const { data } of messages) {
        assert.equal(Buffer.from(unwrap(data)).toString(), unwrap(data), 'UTF-16 pairs survive WebSocket UTF-8 encoding');
      }
    }
  }
});

test('unclosed large control strings stream unchanged and resume safe batching', () => {
  const { output, messages, advance } = harness({ maxBytes: 16 });
  output.push('\x1b]0;' + 'x'.repeat(20));
  output.push('y'.repeat(20));
  output.push('\x1b');
  output.push('\\tail');
  advance(100);
  assert.equal(messages.map(m => m.data).join(''), '\x1b]0;' + 'x'.repeat(20) + 'y'.repeat(20) + '\x1b\\tail');
  output.push('next');
  advance(200);
  assert.equal(messages.at(-1).data, BEGIN + 'next' + END);
});

test('native synchronized updates retain their original lifetime across batches', () => {
  const { output, messages, advance } = harness();
  output.push('\x1b[?25;2026hclear');
  advance(100);
  output.push('repaint');
  advance(200);
  output.push('\x1b[?2026;25l');
  advance(300);
  assert.equal(messages.map(m => m.data).join(''), '\x1b[?25;2026hclearrepaint\x1b[?2026;25l');
  output.push('shell');
  advance(400);
  assert.equal(messages.at(-1).data, BEGIN + 'shell' + END);
});

test('interrupted strings and long native mode lists never get a premature sync end', () => {
  const cases = [
    '\x1b]unfinished title\x1b[?2026h',
    '\x1bPunfinished data\x1b[?2026h',
    '\x1b[?2026;' + '0;'.repeat(200) + '25h',
    '\x1b[?2026:1h'
  ];
  for (const prefix of cases) {
    const { output, messages, advance } = harness();
    output.push(prefix);
    advance(100);
    output.push('protected redraw');
    advance(200);
    assert.equal(messages.map(m => m.data).join(''), prefix + 'protected redraw');
    output.push(END);
    advance(300);
    output.push('normal');
    advance(400);
    assert.equal(messages.at(-1).data, BEGIN + 'normal' + END);
  }
});

test('buffer-limit fallback and explicit flush preserve split emoji', () => {
  const { output, messages, advance } = harness({ maxBytes: 4 });
  const first = '\x1b]0;xxxxxxxx\ud83d';
  output.push(first);
  output.flush();
  output.push('\ude42\x07done');
  advance(100);
  assert.equal(unwrap(messages.map(m => m.data).join('')), first + '\ude42\x07done');
  for (const { data } of messages) assert.equal(Buffer.from(data).toString(), data);
});

test('continuous output has bounded delay and capped complete batches', () => {
  const { output, messages, advance } = harness();
  for (let i = 0; i < 20; i += 1) {
    advance(i * 20);
    output.push('line\r\n');
  }
  advance(500);
  assert.equal(messages[0].atMs, 64);
  assert.equal(unwrap(messages.map(m => m.data).join('')), 'line\r\n'.repeat(20));
  const capped = harness({ maxBytes: 16 });
  capped.output.push('x'.repeat(16));
  assert.equal(capped.messages.length, 1);
  assert.equal(capped.messages[0].atMs, 0);
});

test('exit drains output while disconnect discards pending writes and timers', () => {
  const closing = harness();
  closing.output.push('last line\x1b[');
  closing.output.flush();
  closing.advance(200);
  assert.equal(unwrap(closing.messages.map(m => m.data).join('')), 'last line\x1b[');
  const disconnected = harness();
  disconnected.output.push('must not reach another session');
  disconnected.output.dispose();
  disconnected.advance(200);
  disconnected.output.push('late PTY event');
  assert.deepEqual(disconnected.messages, []);
});
