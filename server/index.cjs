const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const express = require('express');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');

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
const SCREEN_BIN = process.env.SCREEN_BIN || 'screen';
const SCREEN_RC = process.env.SCREEN_PLUS_SCREENRC || path.join(process.cwd(), 'screen-plus.screenrc');
const SCREEN_SHELL = process.env.SCREEN_PLUS_SHELL || '';
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
    description: 'A web terminal for GNU Screen sessions.',
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

function screenArgs(args) {
  const baseArgs = ['-U', '-c', SCREEN_RC];
  if (SCREEN_SHELL) baseArgs.push('-s', SCREEN_SHELL);
  return [...baseArgs, ...args];
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

function normalizeTerminalSize(cols, rows) {
  return {
    cols: Math.max(20, Math.min(300, Number(cols) || 120)),
    rows: Math.max(6, Math.min(120, Number(rows) || 32))
  };
}

function execScreen(args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(SCREEN_BIN, screenArgs(args), {
      timeout: 10000,
      cwd: options.cwd || process.cwd(),
      env: terminalEnv()
    }, (error, stdout, stderr) => {
      if (error && error.code !== 1) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr, code: error ? error.code : 0 });
    });
  });
}

function createAttachedThenDetachSession(sessionName, size) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let detachTimer;
    let timeoutTimer;

    const term = pty.spawn(SCREEN_BIN, screenArgs(['-S', sessionName]), {
      name: 'xterm-256color',
      cols: size.cols,
      rows: size.rows,
      cwd: SHELL_HOME,
      env: terminalEnv()
    });

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(detachTimer);
      clearTimeout(timeoutTimer);
      if (error) {
        try {
          term.kill();
        } catch {
          // The process may already have exited.
        }
        reject(error);
        return;
      }
      resolve();
    };

    detachTimer = setTimeout(() => {
      term.write('\x01d');
    }, 350);

    timeoutTimer = setTimeout(() => {
      finish(new Error('Timed out while creating screen session.'));
    }, 5000);

    term.onExit(({ exitCode, signal }) => {
      if (exitCode === 0) {
        finish();
        return;
      }
      finish(new Error(`screen exited while creating session (${signal || exitCode}).`));
    });
  });
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

function parseScreenList(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .map((line) => {
      const match = line.match(/^(\d+\.[^\s]+)\s+(.*)$/);
      if (!match) return null;

      const [, id, detail] = match;
      const statusMatch = detail.match(/\((Attached|Detached|Multi|Dead)\)\s*$/i);
      const status = statusMatch ? statusMatch[1].toLowerCase() : 'unknown';
      const dateMatch = detail.match(/\((\d{1,4}[/-]\d{1,2}[/-]\d{1,4}[^)]*)\)/);
      const name = id.includes('.') ? id.slice(id.indexOf('.') + 1) : id;

      return {
        id,
        name,
        status,
        attached: status === 'attached' || status === 'multi',
        lastSeen: dateMatch ? dateMatch[1] : null,
        managed: name === SESSION_PREFIX || name.startsWith(`${SESSION_PREFIX}-`)
      };
    })
    .filter(Boolean);
}

async function listSessions() {
  const { stdout, stderr } = await execScreen(['-ls']);
  return parseScreenList(`${stdout}\n${stderr}`);
}

function validateSessionName(sessionName) {
  if (!/^[A-Za-z0-9_.:@-]{1,64}$/.test(sessionName)) {
    const error = new Error('Session name can only contain letters, numbers, dot, underscore, colon, at sign, and dash.');
    error.status = 400;
    throw error;
  }
}

async function createSession(name, sizeInput = null) {
  const sessionName = name || `${SESSION_PREFIX}-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  validateSessionName(sessionName);

  const size = sizeInput ? normalizeTerminalSize(sizeInput.cols, sizeInput.rows) : null;
  if (size) {
    await createAttachedThenDetachSession(sessionName, size);
  } else {
    await execScreen(['-dmS', sessionName], { cwd: SHELL_HOME });
  }
  const sessions = await listSessions();
  const created = sessions.find((session) => session.name === sessionName || session.id.endsWith(`.${sessionName}`));

  if (!created) {
    throw new Error('screen reported success, but the created session was not found.');
  }

  rememberSession(created.id);
  return created;
}

async function resizeSessionWindow(value, cols, rows) {
  const nextCols = Math.max(20, Math.min(300, Number(cols) || 120));
  const nextRows = Math.max(6, Math.min(120, Number(rows) || 32));

  try {
    await execScreen(['-S', value, '-X', 'height', '-w', String(nextRows), String(nextCols)]);
  } catch {
    // The attach path also uses screen -A; sizing here is best-effort for first paint.
  }
}

function resolveSession(sessions, value) {
  return sessions.find((session) => session.id === value || session.name === value);
}

async function closeSession(value) {
  const sessions = await listSessions();
  const session = resolveSession(sessions, value);

  if (!session) {
    const error = new Error('Session not found.');
    error.status = 404;
    throw error;
  }

  await execScreen(['-S', session.id, '-X', 'quit']);
  forgetSession(session.id);
  return session;
}

async function renameSession(value, nextName) {
  validateSessionName(nextName);

  const sessions = await listSessions();
  const session = resolveSession(sessions, value);

  if (!session) {
    const error = new Error('Session not found.');
    error.status = 404;
    throw error;
  }

  if (sessions.some((item) => item.id !== session.id && item.name === nextName)) {
    const error = new Error('Session name already exists.');
    error.status = 409;
    throw error;
  }

  await execScreen(['-S', session.id, '-X', 'sessionname', nextName]);

  const pid = session.id.split('.')[0];
  const nextSessions = await listSessions();
  const renamed = nextSessions.find((item) => item.id.startsWith(`${pid}.`));

  if (!renamed) {
    throw new Error('screen renamed the session, but the updated session was not found.');
  }

  rememberSession(renamed.id);
  return renamed;
}

async function selectDefaultSession(sizeInput = null) {
  let sessions = await listSessions();

  const { lastSessionId } = readState();
  if (!lastSessionId) return createSession(null, sizeInput);

  if (!sessions.length) return createSession(null, sizeInput);

  const last = lastSessionId ? resolveSession(sessions, lastSessionId) : null;
  if (last && !last.attached) {
    rememberSession(last.id);
    return last;
  }

  const detached = sessions.find((session) => session.id !== lastSessionId && !session.attached && session.status !== 'dead');
  if (detached) {
    rememberSession(detached.id);
    return detached;
  }

  return createSession(null, sizeInput);
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
    const state = readState();
    const sessions = await listSessions();
    res.json({ sessions, lastSessionId: state.lastSessionId || null });
  } catch (error) {
    next(error);
  }
});

app.post('/api/sessions/default', async (req, res, next) => {
  try {
    const session = await selectDefaultSession({ cols: req.body?.cols, rows: req.body?.rows });
    await resizeSessionWindow(session.id, req.body?.cols, req.body?.rows);
    res.json({ session });
  } catch (error) {
    next(error);
  }
});

app.post('/api/sessions', async (req, res, next) => {
  try {
    const session = await createSession(req.body?.name, { cols: req.body?.cols, rows: req.body?.rows });
    await resizeSessionWindow(session.id, req.body?.cols, req.body?.rows);
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
  const { cols, rows } = normalizeTerminalSize(url.searchParams.get('cols'), url.searchParams.get('rows'));

  if (!requestedSession) {
    ws.send('\r\nscreen-plus: missing session id\r\n');
    ws.close(1008);
    return;
  }

  let term;
  try {
    const sessions = await listSessions();
    const session = resolveSession(sessions, requestedSession);

    if (!session) {
      ws.send(`\r\nscreen-plus: session not found: ${requestedSession}\r\n`);
      ws.close(1008);
      return;
    }

    await resizeSessionWindow(session.id, cols, rows);
    const args = screenArgs(force ? ['-A', '-D', '-r', session.id] : ['-A', '-r', session.id]);
    rememberSession(session.id);

    term = pty.spawn(SCREEN_BIN, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: SHELL_HOME,
      env: terminalEnv()
    });

    term.onData((data) => {
      if (ws.readyState === ws.OPEN) ws.send(data);
    });

    term.onExit(({ exitCode, signal }) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(`\r\nscreen-plus: screen exited (${signal || exitCode})\r\n`);
        ws.close();
      }
    });
  } catch (error) {
    ws.send(`\r\nscreen-plus: ${error.message}\r\n`);
    ws.close(1011);
    return;
  }

  ws.on('message', (message) => {
    try {
      const payload = JSON.parse(message.toString());
      if (payload.type === 'input' && typeof payload.data === 'string') {
        term.write(payload.data);
      }
      if (payload.type === 'resize') {
        const { cols: nextCols, rows: nextRows } = normalizeTerminalSize(payload.cols, payload.rows);
        term.resize(nextCols, nextRows);
        resizeSessionWindow(requestedSession, nextCols, nextRows).catch(() => {});
      }
    } catch {
      term.write(message.toString());
    }
  });

  ws.on('close', () => {
    if (term) term.kill();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`screen-plus listening on http://${HOST}:${PORT}`);
});
