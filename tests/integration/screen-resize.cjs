// Optional integration test; requires GNU Screen, stty, Node, and node-pty.
// Run locally: node tests/integration/screen-resize.cjs
// Or with the application container's dependencies:
// docker exec -i -w /app screen-plus node < tests/integration/screen-resize.cjs
// All sessions use a private SCREENDIR. Existing sessions are never touched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const pty = require('node-pty');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const screenBin = process.env.SCREEN_BIN || 'screen';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-plus-resize-test-'));
const screenDir = path.join(root, 'sockets');
fs.mkdirSync(screenDir, { mode: 0o700 });
const screenrc = path.join(root, 'screenrc');
fs.writeFileSync(screenrc, [
  'startup_message off',
  'vbell off',
  'termcapinfo xterm* ti@:te@',
  'defutf8 on',
  'utf8 on on',
  ''
].join('\n'));

const log = path.join(root, 'sizes.jsonl');
const probe = path.join(root, 'probe.cjs');
fs.writeFileSync(probe, String.raw`
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
function record(event) {
  // Read the kernel PTY size; stdout.columns can still be stale inside a
  // SIGWINCH handler before Node's own TTY handler refreshes its cache.
  const size = execFileSync('stty', ['size'], {
    stdio: [0, 'pipe', 'pipe']
  }).toString().trim();
  fs.appendFileSync(process.env.PROBE_LOG, JSON.stringify({ event, size }) + '\n');
}
process.stdin.setRawMode(true);
process.stdin.resume();
process.on('SIGWINCH', () => record('SIGWINCH'));
record('start');
process.stdout.write('ISOLATED resize probe\r\nPROMPT test footer');
`);

const env = {
  ...process.env,
  SCREENDIR: screenDir,
  TERM: 'xterm-256color',
  PROBE_LOG: log
};
const session = 'resize-test';
let terminal;
let outputBytes = 0;
let succeeded = false;

function screen(args) {
  return execFileSync(screenBin, ['-U', '-c', screenrc, ...args], {
    env,
    encoding: 'utf8',
    timeout: 5000
  });
}

function events() {
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

async function waitForSize(rows, cols) {
  const expected = `${rows} ${cols}`;
  for (let attempt = 0; attempt < 200; attempt++) {
    if (events().at(-1)?.size === expected) return;
    await sleep(10);
  }
  assert.fail(`Expected inner stty size ${expected}; events: ${JSON.stringify(events())}`);
}

async function run() {
  console.log(execFileSync(screenBin, ['--version'], { encoding: 'utf8' }).trim());
  screen(['-dmS', session, process.execPath, probe]);
  await waitForSize(24, 80);

  terminal = pty.spawn(screenBin, ['-U', '-c', screenrc, '-A', '-r', session], {
    cols: 120,
    rows: 32,
    cwd: root,
    env
  });
  terminal.onData((data) => { outputBytes += Buffer.byteLength(data); });
  await waitForSize(32, 120);
  console.log('PASS: attach -A propagates the display size into the inner PTY.');

  for (const [cols, rows] of [[80, 24], [150, 42], [41, 11], [220, 80], [105, 35]]) {
    terminal.resize(cols, rows);
    await waitForSize(rows, cols);
  }
  console.log('PASS: PTY resize alone propagates all five subsequent sizes.');

  for (let index = 0; index < 60; index++) {
    terminal.resize(70 + index % 17, 20 + index % 11);
    await sleep(1);
  }
  terminal.resize(181, 57);
  await waitForSize(57, 181);
  await sleep(150);
  assert.equal(events().at(-1).size, '57 181');
  console.log('PASS: 60 rapid changes settle at the latest requested size, 181 x 57.');

  const previousEvents = events().length;
  const previousBytes = outputBytes;
  for (let index = 0; index < 20; index++) {
    terminal.resize(181, 57);
    await sleep(1);
  }
  await sleep(150);
  assert.equal(events().length, previousEvents);
  assert.equal(outputBytes, previousBytes);
  console.log('PASS: 20 identical PTY sizes cause no inner SIGWINCH or Screen output.');

  // Deterministically model a delayed command from the old, independent
  // screen -X resize channel arriving after a newer PTY resize.
  terminal.resize(151, 47);
  await waitForSize(47, 151);
  screen(['-S', session, '-X', 'height', '-w', '57', '181']);
  await waitForSize(57, 181);
  assert.equal(terminal.cols, 151);
  assert.equal(terminal.rows, 47);
  console.log('PASS: a stale height command reproduces mismatched outer/inner PTY sizes.');

  // Linux does not signal an unchanged outer TIOCSWINSZ. Sending the correct
  // outer dimensions again therefore cannot repair the inner stale size.
  const staleEvents = events().length;
  terminal.resize(151, 47);
  await sleep(150);
  assert.equal(events().length, staleEvents);
  assert.equal(events().at(-1).size, '57 181');
  console.log('PASS: repeating the correct outer dimensions does not repair the stale inner size.');

  terminal.resize(152, 47);
  await waitForSize(47, 152);
  terminal.resize(151, 47);
  await waitForSize(47, 151);
  succeeded = true;
}

run().catch((error) => {
  console.error(error);
  console.error(`Diagnostic files retained at ${root}`);
  process.exitCode = 1;
}).finally(() => {
  try { screen(['-S', session, '-X', 'quit']); } catch {}
  try { terminal?.kill(); } catch {}
  if (succeeded) fs.rmSync(root, { recursive: true, force: true });
});
