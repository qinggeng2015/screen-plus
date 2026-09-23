// End-to-end HTTP/WebSocket test against an isolated server and private Screen
// socket directory. Run: node tests/integration/terminal-web.cjs
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const WebSocket = require('ws');
const { Terminal } = require('@xterm/headless');

const root = path.resolve(__dirname, '../..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-plus-web-test-'));
const screenDir = path.join(temporary, 'sockets');
fs.mkdirSync(screenDir, { mode: 0o700 });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sessions = [];
const connections = [];
let child;
let logs = '';
let base;
let cookie;
let env;

async function until(check, label) {
  for (let i = 0; i < 160; i++) {
    if (await check()) return;
    await sleep(25);
  }
  throw new Error(`Timed out: ${label}`);
}

async function request(route, method = 'GET', body) {
  return fetch(base + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function create(backend, name) {
  const response = await request('/api/sessions', 'POST', { backend, name, cols: 80, rows: 24 });
  assert.equal(response.status, 201, await response.clone().text());
  const { session } = await response.json();
  sessions.push(session.id);
  return session;
}

async function connect(session, force = false) {
  const ws = new WebSocket(base.replace('http:', 'ws:') + '/term?' + new URLSearchParams({
    session: session.id, cols: '80', rows: '24', force: force ? '1' : '0'
  }), { headers: { Cookie: cookie } });
  connections.push(ws);
  const result = { ws, chunks: [], snapshots: [], stream: '', closeCode: null, pong: false };
  ws.on('message', (data, binary) => {
    const text = data.toString();
    if (!binary) {
      try {
        const control = JSON.parse(text);
        if (control.type === 'snapshot') { result.snapshots.push(control); return; }
        if (control.type === 'pong') { result.pong = true; return; }
      } catch {}
    }
    result.chunks.push({ data: text, binary, at: Date.now() });
    result.stream += text;
  });
  ws.on('close', code => { result.closeCode = code; });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket open timed out')), 4000);
    ws.once('open', () => { clearTimeout(timer); resolve(); });
    ws.once('error', error => { clearTimeout(timer); reject(error); });
  });
  result.send = (type, data) => ws.send(JSON.stringify(type === 'input' ? { type, data } : { type, ...data }));
  if (session.backend === 'direct') await until(() => result.snapshots.length, 'direct snapshot');
  return result;
}

async function snapshotText(snapshot) {
  const terminal = new Terminal({ cols: snapshot.cols, rows: snapshot.rows, allowProposedApi: true });
  await new Promise(resolve => terminal.write(snapshot.data, resolve));
  const buffer = terminal.buffer.active;
  const text = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i).translateToString(true)).join('\n');
  terminal.dispose();
  return text;
}

async function run() {
  const reserve = net.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  base = `http://127.0.0.1:${port}/screen`;
  env = { ...process.env, HOST: '127.0.0.1', PORT: String(port),
    SCREEN_PLUS_STATE_DIR: temporary, SCREEN_PLUS_CONFIG: path.join(temporary, 'config.json'),
    SCREEN_PLUS_HOME: temporary, SCREEN_PLUS_SHELL: '/bin/sh', SCREENDIR: screenDir };
  child = spawn(process.execPath, ['server/index.cjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { logs += data; });
  child.stderr.on('data', data => { logs += data; });
  await until(async () => {
    if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
    try { return (await request('/api/health')).ok; } catch { return false; }
  }, 'server startup');
  assert.equal((await request('/api/sessions')).status, 401);
  const setup = await request('/api/auth/setup', 'POST', {
    username: 'isolated-test', password: crypto.randomBytes(24).toString('hex')
  });
  assert.equal(setup.status, 201);
  cookie = setup.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/sessions', 'POST', { backend: 'invalid' })).status, 400);

  const direct = await create('direct', 'direct-test');
  assert.equal(direct.backend, 'direct');
  let client = await connect(direct);
  client.send('input', "SP_WEB_TEST=preserved; printf '%s%s\\n' 'DIRECT_' 'READY'\r");
  await until(() => client.stream.includes('DIRECT_READY'), 'direct input');
  client.send('ping', { id: 'direct-heartbeat' });
  await until(() => client.pong, 'direct heartbeat');
  const start = client.chunks.length;
  client.send('input', "printf '\\033[?2026hNATIVE_BEGIN'; sleep 0.15; printf 'NATIVE_END\\033[?2026l\\n'\r");
  await until(() => client.chunks.slice(start).some(chunk => chunk.data.includes('\x1b[?2026l')), 'native frame end');
  const native = client.chunks.slice(start);
  const raw = native.map(chunk => chunk.data).join('');
  assert.equal(raw.split('\x1b[?2026h').length - 1, 1);
  assert.equal(raw.split('\x1b[?2026l').length - 1, 1);
  assert.ok(native.every(chunk => chunk.binary));
  const begin = native.find(chunk => chunk.data.includes('\x1b[?2026h'));
  const end = native.find(chunk => chunk.data.includes('\x1b[?2026l'));
  assert.ok(end.at - begin.at >= 80, 'native synchronization spans separate delayed messages');
  console.log('PASS: authenticated direct PTY, input, heartbeat, and native sync across a 150ms gap.');

  client.send('input', "(sleep 0.2; printf '%s%s\\n' 'OFFLINE_' 'OUTPUT') &\r");
  await sleep(50);
  client.ws.close();
  await until(() => client.closeCode !== null, 'disconnect');
  await sleep(250);
  const selected = await (await request('/api/sessions/default', 'POST', { cols: 80, rows: 24 })).json();
  assert.equal(selected.session.id, direct.id);
  client = await connect(direct);
  assert.match(await snapshotText(client.snapshots[0]), /OFFLINE_OUTPUT/);
  client.send('input', "printf '%s:%s\\n' 'PERSISTED' \"$SP_WEB_TEST\"\r");
  await until(() => client.stream.includes('PERSISTED:preserved'), 'same shell after reconnect');
  assert.equal((await (await request('/api/sessions/default', 'POST', {})).json()).session.id, direct.id);
  const replacement = await connect(direct, true);
  await until(() => client.closeCode !== null, 'takeover');
  assert.equal(client.closeCode, 4001);
  client = replacement;
  console.log('PASS: refresh restores detached output and the same shell; takeover closes the old page with 4001.');

  for (let i = 0; i < 40; i++) client.send('resize', { cols: 70 + i, rows: 15 + i % 10 });
  client.send('resize', { cols: 91, rows: 27 });
  await sleep(100);
  client.send('input', 'stty size\r');
  await until(() => client.stream.includes('27 91'), 'direct latest resize');
  client.send('input', "printf '%s%s\\n' '中文🙂' '通过'\r");
  await until(() => client.stream.includes('中文🙂通过'), 'Unicode output');
  assert.equal((await request(`/api/sessions/${direct.id}`, 'PATCH', { name: 'direct-renamed' })).status, 200);
  assert.equal((await request(`/api/sessions/${direct.id}`, 'DELETE')).status, 200);
  await until(() => client.closeCode !== null, 'direct session close');

  const screen = await create('screen', 'screen-regression');
  const screenClient = await connect(screen);
  for (let i = 0; i < 40; i++) screenClient.send('resize', { cols: 70 + i, rows: 15 + i % 10 });
  screenClient.send('resize', { cols: 93, rows: 29 });
  await sleep(150);
  screenClient.send('input', 'stty size\r');
  await until(() => screenClient.stream.includes('29 93'), 'Screen latest resize');
  screenClient.send('input', "printf '%s%s\\n' 'SCREEN_' 'READY'\r");
  await until(() => screenClient.stream.includes('SCREEN_READY'), 'Screen regression');
  console.log('PASS: direct resize/Unicode/rename/close and existing Screen HTTP/WebSocket path.');
}

run().catch(error => {
  console.error(error);
  console.error(logs);
  process.exitCode = 1;
}).finally(async () => {
  for (const ws of connections) ws.terminate();
  if (base && cookie) {
    for (const id of sessions) {
      try { await request(`/api/sessions/${id}`, 'DELETE'); } catch {}
    }
  }
  if (env) {
    for (const id of sessions.filter(id => !id.startsWith('direct-'))) {
      try { execFileSync(process.env.SCREEN_BIN || 'screen', ['-S', id, '-X', 'quit'], { env, stdio: 'ignore' }); } catch {}
    }
  }
  child?.kill();
  if (child && child.exitCode === null) await new Promise(resolve => child.once('exit', resolve));
  fs.rmSync(temporary, { recursive: true, force: true });
});
