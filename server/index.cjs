const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');
const { normalizeTerminalSize } = require('./terminal-size.cjs');
const { createTerminalSessions } = require('./terminal-sessions.cjs');

function isUtf8Locale(value) {
  return /utf-?8/i.test(String(value || ''));
}

function usableUtf8Locale(value) {
  const locale = String(value || '').trim();
  if (!isUtf8Locale(locale)) return '';
  return /^utf-?8$/i.test(locale) ? '' : locale;
}

function normalizeBasePath(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed === '/') return '';

  const normalized = trimmed.split('/').filter(Boolean).join('/');
  return normalized ? `/${normalized}` : '';
}

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const TERMINAL_SHELL = process.env.SCREEN_PLUS_SHELL || process.env.SHELL || '/bin/sh';
const STATE_DIR = process.env.SCREEN_PLUS_STATE_DIR || path.join(process.cwd(), '.screen-plus');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const CONFIG_FILE = process.env.SCREEN_PLUS_CONFIG
  ? path.resolve(process.env.SCREEN_PLUS_CONFIG)
  : path.join(STATE_DIR, 'config.json');
const SESSION_PREFIX = process.env.SCREEN_PLUS_PREFIX || 'sp';
const STATIC_DIR = path.join(process.cwd(), 'dist');
const INDEX_HTML = path.join(STATIC_DIR, 'index.html');
const BASE_PATH = normalizeBasePath(process.env.SCREEN_PLUS_BASE_PATH);
const AUTH_COOKIE = 'screen_plus_session';
const AUTH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_KEY_LENGTH = 64;
const UTF8_LOCALE = process.env.SCREEN_PLUS_LOCALE
  || usableUtf8Locale(process.env.LANG)
  || usableUtf8Locale(process.env.LC_CTYPE)
  || usableUtf8Locale(process.env.LC_ALL)
  || 'C.UTF-8';
const SHELL_HOME = process.env.SCREEN_PLUS_HOME || process.env.HOME || os.homedir() || process.cwd();
const terminalSessions = createTerminalSessions({
  spawn: pty.spawn,
  shell: TERMINAL_SHELL,
  cwd: SHELL_HOME,
  env: terminalEnv(),
  onExit(session) { forgetSession(session.id); }
});

const app = express();
app.use(stripBasePath);
app.use(express.json());

function parseRequestUrl(value) {
  return new URL(value || '/', 'http://screen-plus.local');
}

function replaceRequestPath(value, pathname) {
  const url = parseRequestUrl(value);
  return `${pathname}${url.search}`;
}

function forwardedBasePath(req) {
  const header = req.headers['x-forwarded-prefix'];
  const value = Array.isArray(header) ? header[0] : String(header || '').split(',')[0];
  return normalizeBasePath(value);
}

function inferredServicePath(pathname) {
  for (const segment of ['api', 'assets', 'term', 'icons', 'manifest.json', 'manifest.webmanifest', 'service-worker.js']) {
    const rootPath = `/${segment}`;
    if (pathname === rootPath || pathname.startsWith(`${rootPath}/`)) {
      return { basePath: '', pathname };
    }

    const marker = `/${segment}`;
    const index = pathname.indexOf(marker);
    if (index <= 0) continue;

    const nextChar = pathname[index + marker.length];
    if (nextChar && nextChar !== '/') continue;

    return {
      basePath: normalizeBasePath(pathname.slice(0, index)),
      pathname: pathname.slice(index) || '/'
    };
  }

  return null;
}

function inferredPageBasePath(pathname) {
  if (!pathname || pathname === '/') return '';

  const cleanPath = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const lastSegment = cleanPath.split('/').pop() || '';
  if (lastSegment.includes('.')) {
    return normalizeBasePath(cleanPath.slice(0, -(lastSegment.length + 1)));
  }

  return normalizeBasePath(cleanPath);
}

function acceptsHtml(req) {
  const accept = String(req.headers.accept || '');
  return !accept || accept.includes('text/html') || accept.includes('*/*');
}

function shouldRedirectToDirectory(req, pathname) {
  if (!pathname || pathname === '/' || pathname.endsWith('/')) return false;
  if (inferredServicePath(pathname)) return false;
  if ((pathname.split('/').pop() || '').includes('.')) return false;
  return acceptsHtml(req);
}

function requestBasePath(req) {
  return BASE_PATH || forwardedBasePath(req) || normalizeBasePath(req.screenPlusBasePath);
}

function withRequestBasePath(req, pathname) {
  const normalizedPathname = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${requestBasePath(req)}${normalizedPathname}`;
}

function appScope(req) {
  return `${requestBasePath(req) || ''}/`;
}

function webManifest(req) {
  const scope = appScope(req);
  return {
    name: 'Screen Plus',
    short_name: 'Screen Plus',
    description: 'A web shell with persistent sessions and reconnectable terminal views.',
    id: scope,
    start_url: scope,
    scope,
    display: 'standalone',
    display_override: ['window-controls-overlay', 'standalone', 'browser'],
    background_color: '#ffffff',
    theme_color: '#ffffff',
    categories: ['utilities', 'productivity', 'developer'],
    icons: [
      {
        src: withRequestBasePath(req, '/icons/icon-192.png'),
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any maskable'
      },
      {
        src: withRequestBasePath(req, '/icons/icon-512.png'),
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable'
      }
    ]
  };
}

function stripBasePath(req, res, next) {
  const url = parseRequestUrl(req.url);

  if (!BASE_PATH) {
    const inferred = inferredServicePath(url.pathname);
    if (inferred) {
      req.screenPlusBasePath = inferred.basePath;
      req.url = replaceRequestPath(req.url, inferred.pathname);
      next();
      return;
    }

    if (shouldRedirectToDirectory(req, url.pathname)) {
      res.redirect(308, `${url.pathname}/${url.search}`);
      return;
    }

    req.screenPlusBasePath = forwardedBasePath(req) || inferredPageBasePath(url.pathname);
    next();
    return;
  }

  req.screenPlusBasePath = BASE_PATH;

  if (url.pathname === BASE_PATH) {
    const query = url.search || '';
    res.redirect(308, `${BASE_PATH}/${query}`);
    return;
  }

  if (url.pathname.startsWith(`${BASE_PATH}/`)) {
    const nextPathname = url.pathname.slice(BASE_PATH.length) || '/';
    req.url = replaceRequestPath(req.url, nextPathname);
  }

  next();
}

function stripBasePathname(pathname) {
  if (!BASE_PATH) {
    return inferredServicePath(pathname)?.pathname || pathname;
  }

  if (pathname === BASE_PATH) return '/';
  if (pathname.startsWith(`${BASE_PATH}/`)) return pathname.slice(BASE_PATH.length) || '/';
  return pathname;
}

function renderIndexHtml(req) {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const runtimeConfig = `<script>window.__SCREEN_PLUS_BASE_PATH__=${JSON.stringify(requestBasePath(req))};</script>`;

  if (html.includes('</head>')) {
    return html.replace('</head>', `    ${runtimeConfig}\n  </head>`);
  }

  return `${runtimeConfig}\n${html}`;
}

function terminalEnv() {
  const env = { ...process.env };

  for (const key of Object.keys(env)) {
    if (key === 'LC_ALL' || key.startsWith('LC_')) {
      delete env[key];
    }
  }

  return {
    ...env,
    LANG: UTF8_LOCALE,
    LC_CTYPE: UTF8_LOCALE,
    TERM: 'xterm-256color'
  };
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(nextState) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(nextState, null, 2));
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(nextConfig) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(nextConfig, null, 2), { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    // Some filesystems do not support chmod; the config still remains usable.
  }
}

function hasAuthConfig(config) {
  return Boolean(
    config?.auth?.username
    && config.auth.passwordHash
    && config.auth.salt
    && config.auth.algorithm === 'scrypt'
  );
}

function isSetupRequired() {
  return !hasAuthConfig(readConfig());
}

function getConfiguredAuth() {
  const config = readConfig();
  if (!hasAuthConfig(config)) return { config, auth: null };

  if (!config.sessionSecret) {
    config.sessionSecret = crypto.randomBytes(32).toString('hex');
    writeConfig(config);
  }

  return { config, auth: config.auth };
}

function validateUsername(username) {
  if (typeof username !== 'string' || !/^[A-Za-z0-9_.@-]{1,64}$/.test(username)) {
    const error = new Error('Username can only contain letters, numbers, dot, underscore, at sign, and dash.');
    error.status = 400;
    throw error;
  }
}

function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) {
    const error = new Error('Password must be between 8 and 256 characters.');
    error.status = 400;
    throw error;
  }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return {
    salt,
    passwordHash: crypto.scryptSync(password, salt, PASSWORD_KEY_LENGTH).toString('hex'),
    algorithm: 'scrypt',
    keyLength: PASSWORD_KEY_LENGTH
  };
}

function verifyPassword(password, auth) {
  const expected = Buffer.from(auth.passwordHash, 'hex');
  const actual = crypto.scryptSync(password, auth.salt, auth.keyLength || PASSWORD_KEY_LENGTH);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function parseCookies(header) {
  return String(header || '')
    .split(';')
    .map((item) => item.trim())
    .filter(Boolean)
    .reduce((cookies, item) => {
      const separator = item.indexOf('=');
      if (separator < 0) return cookies;

      const name = decodeURIComponent(item.slice(0, separator));
      const value = decodeURIComponent(item.slice(separator + 1));
      cookies[name] = value;
      return cookies;
    }, {});
}

function signValue(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function createAuthToken(username, secret) {
  const payload = Buffer.from(JSON.stringify({
    username,
    exp: Date.now() + AUTH_TOKEN_TTL_MS
  })).toString('base64url');
  return `${payload}.${signValue(payload, secret)}`;
}

function verifyAuthToken(token, secret) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;

  const expected = signValue(payload, secret);
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== signatureBuffer.length || !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)) {
    return null;
  }

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof claims.username !== 'string' || Date.now() > Number(claims.exp)) return null;
    return claims;
  } catch {
    return null;
  }
}

function authCookieAttributes(req, maxAgeSeconds) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  return [
    'HttpOnly',
    'SameSite=Lax',
    `Path=${requestBasePath(req) || '/'}`,
    `Max-Age=${maxAgeSeconds}`,
    secure ? 'Secure' : null
  ].filter(Boolean).join('; ');
}

function setAuthCookie(req, res, username, secret) {
  const token = createAuthToken(username, secret);
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${encodeURIComponent(token)}; ${authCookieAttributes(req, Math.floor(AUTH_TOKEN_TTL_MS / 1000))}`);
}

function clearAuthCookie(req, res) {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; ${authCookieAttributes(req, 0)}`);
}

function getAuthenticatedUser(req) {
  const { config, auth } = getConfiguredAuth();
  if (!auth) return null;

  const token = parseCookies(req.headers.cookie)[AUTH_COOKIE];
  const claims = verifyAuthToken(token, config.sessionSecret);
  if (!claims || claims.username !== auth.username) return null;

  return { username: auth.username };
}

function requireAuth(req, res, next) {
  const user = getAuthenticatedUser(req);
  if (!user) {
    res.status(401).json({
      error: 'Authentication required.',
      setupRequired: isSetupRequired()
    });
    return;
  }

  req.user = user;
  next();
}

function rememberSession(sessionId) {
  writeState({
    ...readState(),
    lastSessionId: sessionId,
    updatedAt: new Date().toISOString()
  });
}

function forgetSession(sessionId) {
  const state = readState();
  if (state.lastSessionId !== sessionId) return;

  const { lastSessionId, ...nextState } = state;
  writeState({
    ...nextState,
    updatedAt: new Date().toISOString()
  });
}

function listSessions() {
  return terminalSessions.list();
}

function resolveSession(value) {
  return terminalSessions.get(value) || listSessions().find((session) => session.name === value);
}

function requireSession(value) {
  const session = resolveSession(value);
  if (!session) throw Object.assign(new Error('Session not found.'), { status: 404 });
  return session;
}

function validateSessionName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9_.:@-]{1,64}$/.test(name)) {
    throw Object.assign(new Error('Session name can only contain letters, numbers, dot, underscore, colon, at sign, and dash.'), { status: 400 });
  }
}

function createSession(name, sizeInput = {}) {
  const sessionName = name === undefined || name === null || name === ''
    ? `${SESSION_PREFIX}-${crypto.randomBytes(4).toString('hex')}`
    : name;
  validateSessionName(sessionName);
  if (listSessions().some((session) => session.name === sessionName)) {
    throw Object.assign(new Error('Session name already exists.'), { status: 409 });
  }
  const size = normalizeTerminalSize(sizeInput?.cols, sizeInput?.rows);
  const session = terminalSessions.create(sessionName, size);
  rememberSession(session.id);
  return session;
}

async function closeSession(value) {
  const session = requireSession(value);
  await terminalSessions.close(session.id);
  forgetSession(session.id);
  return session;
}

function renameSession(value, nextName) {
  validateSessionName(nextName);
  const session = requireSession(value);
  if (listSessions().some((item) => item.id !== session.id && item.name === nextName)) {
    throw Object.assign(new Error('Session name already exists.'), { status: 409 });
  }
  return terminalSessions.rename(session.id, nextName);
}

function selectDefaultSession(sizeInput = {}) {
  // The old WebSocket may still be attached when a refreshed page arrives.
  // Returning the same process lets the client explicitly take over its view.
  const session = terminalSessions.get(readState().lastSessionId)
    || listSessions().find((item) => !item.attached);
  if (!session) return createSession(undefined, sizeInput);
  rememberSession(session.id);
  return session;
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/auth/status', (req, res) => {
  const setupRequired = isSetupRequired();
  const { auth } = getConfiguredAuth();
  const user = setupRequired ? null : getAuthenticatedUser(req);

  res.json({
    authenticated: Boolean(user),
    setupRequired,
    username: user?.username || auth?.username || null
  });
});

app.post('/api/auth/setup', (req, res, next) => {
  try {
    if (!isSetupRequired()) {
      res.status(409).json({ error: 'Authentication is already configured.' });
      return;
    }

    const username = String(req.body?.username || '').trim();
    const password = req.body?.password;
    validateUsername(username);
    validatePassword(password);

    const passwordConfig = hashPassword(password);
    const config = {
      auth: {
        username,
        ...passwordConfig,
        updatedAt: new Date().toISOString()
      },
      sessionSecret: crypto.randomBytes(32).toString('hex')
    };

    writeConfig(config);
    setAuthCookie(req, res, username, config.sessionSecret);
    res.status(201).json({ authenticated: true, setupRequired: false, username });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/login', (req, res, next) => {
  try {
    const { config, auth } = getConfiguredAuth();
    if (!auth) {
      res.status(428).json({ error: 'Password setup is required.', setupRequired: true });
      return;
    }

    const username = String(req.body?.username || '').trim();
    const password = req.body?.password;
    if (username !== auth.username || typeof password !== 'string' || !verifyPassword(password, auth)) {
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }

    setAuthCookie(req, res, auth.username, config.sessionSecret);
    res.json({ authenticated: true, setupRequired: false, username: auth.username });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(req, res);
  res.json({ authenticated: false });
});

app.use('/api/sessions', requireAuth);

app.get('/api/sessions', async (_req, res, next) => {
  try {
    const sessions = await listSessions();
    const state = readState();
    res.json({ sessions, lastSessionId: state.lastSessionId || null });
  } catch (error) {
    next(error);
  }
});

app.post('/api/sessions/default', (req, res, next) => {
  try {
    const session = selectDefaultSession({ cols: req.body?.cols, rows: req.body?.rows });
    res.json({ session });
  } catch (error) {
    next(error);
  }
});

app.post('/api/sessions', (req, res, next) => {
  try {
    const session = createSession(req.body?.name, { cols: req.body?.cols, rows: req.body?.rows });
    res.status(201).json({ session });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/sessions/:id', async (req, res, next) => {
  try {
    const session = await renameSession(req.params.id, req.body?.name);
    res.json({ session });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/sessions/:id', async (req, res, next) => {
  try {
    const session = await closeSession(req.params.id);
    res.json({ session });
  } catch (error) {
    next(error);
  }
});

if (fs.existsSync(STATIC_DIR)) {
  app.get('/manifest.json', (req, res) => {
    res.type('application/manifest+json').json(webManifest(req));
  });
  app.get('/manifest.webmanifest', (req, res) => {
    res.type('application/manifest+json').json(webManifest(req));
  });
  app.use(express.static(STATIC_DIR, { index: false }));
  app.get('*', (req, res) => {
    res.type('html').send(renderIndexHtml(req));
  });
} else {
  app.get('*', (_req, res) => {
    res.status(404).send('Frontend build not found. Run `npm run build`, or use `npm run dev` during development.');
  });
}

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  res.status(status).json({
    error: error.message || 'Unexpected server error',
    detail: error.stderr || undefined
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

async function connectTerminal(ws, sessionId, force) {
  let attachment = null;
  let closed = false;
  const pendingInput = [];
  let pendingBytes = 0;
  let pendingSize = null;
  const send = (data, binary = false) => {
    if (closed || ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > 4 * 1024 * 1024) {
      ws.close(1013, 'Terminal connection is too slow');
      return;
    }
    // Terminal bytes use binary frames so an application's printed JSON can
    // never be mistaken for a snapshot or a heartbeat control message.
    ws.send(binary ? Buffer.from(data) : data);
  };

  ws.on('close', () => {
    closed = true;
    pendingInput.length = 0;
    attachment?.detach();
  });
  ws.on('message', (message) => {
    if (closed) return;
    let payload;
    try {
      payload = JSON.parse(message.toString());
    } catch {
      return;
    }
    if (!payload) return;
    try {
      if (payload.type === 'ping' && typeof payload.id === 'string') {
        send(JSON.stringify({ type: 'pong', id: payload.id }));
      } else if (payload.type === 'input' && typeof payload.data === 'string') {
        if (attachment) {
          attachment.write(payload.data);
        } else {
          pendingBytes += Buffer.byteLength(payload.data);
          if (pendingBytes > 64 * 1024 || pendingInput.length >= 256) {
            ws.close(1009, 'Too much input before terminal attachment');
            return;
          }
          pendingInput.push(payload.data);
        }
      } else if (payload.type === 'resize') {
        const next = normalizeTerminalSize(payload.cols, payload.rows);
        if (attachment) {
          attachment.resize(next.cols, next.rows).catch(() => {
            if (ws.readyState === ws.OPEN) ws.close(1011, 'Terminal resize failed');
          });
        }
        else pendingSize = next;
      }
    } catch {
      ws.close(1011, 'Terminal operation failed');
    }
  });

  try {
    attachment = await terminalSessions.attach(sessionId, {
      force,
      onSnapshot(snapshot) { send(JSON.stringify({ type: 'snapshot', ...snapshot })); },
      onData(data) { send(data, true); },
      onExit({ exitCode, signal }) {
        send(`\r\nscreen-plus: terminal exited (${signal || exitCode})\r\n`, true);
        ws.close(1000, 'Terminal exited');
      },
      onDetach(reason) {
        closed = true;
        if (ws.readyState === ws.OPEN) {
          ws.close(reason === 'taken-over' ? 4001 : 1011,
            reason === 'taken-over' ? 'Terminal opened in another page' : 'Terminal connection ended');
        }
      }
    });
    if (closed || ws.readyState !== ws.OPEN) {
      attachment.detach();
      return;
    }
    rememberSession(sessionId);
    if (pendingSize) await attachment.resize(pendingSize.cols, pendingSize.rows);
    if (closed || ws.readyState !== ws.OPEN) return;
    for (const data of pendingInput.splice(0)) attachment.write(data);
  } catch (error) {
    if (!closed && ws.readyState === ws.OPEN) {
      send(`\r\nscreen-plus: ${error.message}\r\n`, true);
      ws.close(error.code === 'ATTACHED' || error.code === 'NOT_FOUND' ? 1008 : 1011, 'Terminal attachment failed');
    }
  }
}

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (stripBasePathname(url.pathname) !== '/term') {
    socket.destroy();
    return;
  }

  if (!getAuthenticatedUser(request)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request, url);
  });
});

wss.on('connection', async (ws, _request, url) => {
  const requestedSession = url.searchParams.get('session');
  const force = url.searchParams.get('force') === '1';

  if (!requestedSession) {
    ws.send(Buffer.from('\r\nscreen-plus: missing session id\r\n'));
    ws.close(1008);
    return;
  }

  await connectTerminal(ws, requestedSession, force);
});

server.listen(PORT, HOST, () => {
  console.log(`screen-plus listening on http://${HOST}:${PORT}`);
});
