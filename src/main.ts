import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import './styles.css';

declare global {
  interface Window {
    __SCREEN_PLUS_BASE_PATH__?: string;
  }
}

declare const __SCREEN_PLUS_DEV_BASE_PATH__: string;

type ScreenSession = {
  id: string;
  name: string;
  status: 'attached' | 'detached' | 'multi' | 'dead' | 'unknown';
  attached: boolean;
  lastSeen: string | null;
  managed: boolean;
};

type SessionResponse = {
  session: ScreenSession;
};

type SessionsResponse = {
  sessions: ScreenSession[];
  lastSessionId: string | null;
};

type AuthStatusResponse = {
  authenticated: boolean;
  setupRequired: boolean;
  username: string | null;
};

type ThemeMode = 'dark' | 'light';

type ViewportMetrics = {
  top: number;
  width: number;
  height: number;
};

type TerminalTouchGesture = {
  startX: number;
  startY: number;
  lastY: number;
  lastTime: number;
  moved: boolean;
  velocity: number;
};

function normalizeBasePath(value: string | undefined) {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed === '/') return '';

  const normalized = trimmed.split('/').filter(Boolean).join('/');
  return normalized ? `/${normalized}` : '';
}

function inferBasePathFromLocation() {
  const pathname = window.location.pathname;
  if (!pathname || pathname === '/') return '';

  const cleanPath = pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  const lastSegment = cleanPath.split('/').pop() || '';
  if (lastSegment.includes('.')) {
    return normalizeBasePath(cleanPath.slice(0, -(lastSegment.length + 1)));
  }

  return normalizeBasePath(cleanPath);
}

const runtimeBasePath = Object.prototype.hasOwnProperty.call(window, '__SCREEN_PLUS_BASE_PATH__')
  ? window.__SCREEN_PLUS_BASE_PATH__
  : __SCREEN_PLUS_DEV_BASE_PATH__;
const appBasePath = normalizeBasePath(runtimeBasePath) || inferBasePathFromLocation();

function withBasePath(path: string) {
  if (/^[a-z][a-z\d+\-.]*:/i.test(path)) return path;

  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${appBasePath}${normalizedPath}`;
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  window.addEventListener('load', () => {
    navigator.serviceWorker.register(withBasePath('/service-worker.js'), {
      scope: `${appBasePath || ''}/`
    }).catch(() => {
      // Service workers require a secure context; LAN HTTP installs may still use the manifest fallback.
    });
  });
}

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('Missing app element');

app.innerHTML = `
  <main class="app-shell" data-menu-open="false" data-drawer-open="false" data-keyboard-open="false" data-theme="dark">
    <section class="terminal-frame" aria-label="远程终端">
      <div class="session-chip" id="sessionChip">正在连接...</div>
      <div class="terminal-host" id="terminalHost"></div>
    </section>

    <section class="auth-gate" id="authGate" data-visible="true" aria-label="访问认证">
      <form class="auth-panel" id="authForm">
        <h1 id="authTitle">登录</h1>
        <label class="auth-field">
          <span>用户名</span>
          <input id="authUsername" name="username" autocomplete="username" />
        </label>
        <label class="auth-field">
          <span>密码</span>
          <input id="authPassword" name="password" type="password" autocomplete="current-password" />
        </label>
        <button class="primary-action auth-submit" id="authSubmit" type="submit">进入</button>
        <p class="auth-message" id="authMessage"></p>
      </form>
    </section>

    <div class="scrim" id="scrim"></div>

    <aside class="session-drawer" id="sessionDrawer" aria-label="screen 会话列表">
      <header class="drawer-header">
        <div>
          <p>Screen 会话</p>
          <span id="drawerMeta">正在读取</span>
        </div>
        <button class="icon-button" id="closeDrawer" type="button" aria-label="关闭会话列表">×</button>
      </header>
      <div class="drawer-actions">
        <button class="primary-action" id="newSession" type="button">新建会话</button>
        <button class="ghost-action" id="refreshSessions" type="button">刷新</button>
      </div>
      <div class="session-list" id="sessionList"></div>
    </aside>

    <nav class="quick-menu" id="quickMenu" aria-label="快速操作">
      <button class="quick-action" id="openSessions" type="button">
        <span class="quick-action-icon">☰</span>
        <span>会话</span>
      </button>
      <button class="quick-action" id="toggleKeyboard" type="button">
        <span class="quick-action-icon">⌨</span>
        <span>键盘</span>
      </button>
      <button class="quick-action" id="toggleTheme" type="button" aria-pressed="false">
        <span class="quick-action-icon" id="themeIcon">☀</span>
        <span id="themeLabel">白天</span>
      </button>
    </nav>

    <button class="fab" id="fab" type="button" aria-label="打开快速操作" aria-expanded="false">
      <span></span>
      <span></span>
      <span></span>
    </button>

    <section class="terminal-keyboard" id="terminalKeyboard" aria-label="终端快捷键盘">
      <button data-key="escape" type="button">esc</button>
      <button data-key="dash" type="button">-</button>
      <button data-key="shift" type="button" aria-pressed="false">shift</button>
      <button data-key="up" type="button" aria-label="上">↑</button>
      <button data-key="down" type="button" aria-label="下">↓</button>
      <button data-key="left" type="button" aria-label="左">←</button>
      <button data-key="right" type="button" aria-label="右">→</button>
      <button data-key="tab" type="button">tab</button>
      <button data-key="ctrl" type="button" aria-pressed="false">ctrl</button>
      <button data-key="alt" type="button" aria-pressed="false">alt</button>
    </section>
  </main>
`;

const shell = document.querySelector<HTMLElement>('.app-shell')!;
const terminalHost = document.querySelector<HTMLDivElement>('#terminalHost')!;
const sessionChip = document.querySelector<HTMLDivElement>('#sessionChip')!;
const sessionDrawer = document.querySelector<HTMLElement>('#sessionDrawer')!;
const sessionList = document.querySelector<HTMLDivElement>('#sessionList')!;
const drawerMeta = document.querySelector<HTMLSpanElement>('#drawerMeta')!;
const fab = document.querySelector<HTMLButtonElement>('#fab')!;
const quickMenu = document.querySelector<HTMLElement>('#quickMenu')!;
const keyboard = document.querySelector<HTMLElement>('#terminalKeyboard')!;
const scrim = document.querySelector<HTMLElement>('#scrim')!;
const themeIcon = document.querySelector<HTMLSpanElement>('#themeIcon')!;
const themeLabel = document.querySelector<HTMLSpanElement>('#themeLabel')!;
const themeToggle = document.querySelector<HTMLButtonElement>('#toggleTheme')!;
const themeColorMeta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
const appleStatusBarMeta = document.querySelector<HTMLMetaElement>('meta[name="apple-mobile-web-app-status-bar-style"]');
const authGate = document.querySelector<HTMLElement>('#authGate')!;
const authForm = document.querySelector<HTMLFormElement>('#authForm')!;
const authTitle = document.querySelector<HTMLHeadingElement>('#authTitle')!;
const authUsername = document.querySelector<HTMLInputElement>('#authUsername')!;
const authPassword = document.querySelector<HTMLInputElement>('#authPassword')!;
const authSubmit = document.querySelector<HTMLButtonElement>('#authSubmit')!;
const authMessage = document.querySelector<HTMLParagraphElement>('#authMessage')!;

const terminalThemes = {
  dark: {
    background: '#06080a',
    foreground: '#d7e1df',
    cursor: '#f0f7f4',
    selectionBackground: '#2b6158',
    black: '#07100f',
    red: '#d65d63',
    green: '#73c991',
    yellow: '#d7ba7d',
    blue: '#6ca8dc',
    magenta: '#c586c0',
    cyan: '#4ec9b0',
    white: '#d4d4d4',
    brightBlack: '#5a6664',
    brightRed: '#f48771',
    brightGreen: '#89d185',
    brightYellow: '#ffd866',
    brightBlue: '#82aaff',
    brightMagenta: '#d670d6',
    brightCyan: '#64d9c4',
    brightWhite: '#ffffff'
  },
  light: {
    background: '#ffffff',
    foreground: '#17211f',
    cursor: '#0f1a18',
    selectionBackground: '#b7ddd4',
    black: '#17211f',
    red: '#b93d45',
    green: '#227a4f',
    yellow: '#9a6a00',
    blue: '#2266a8',
    magenta: '#9a4b99',
    cyan: '#147d73',
    white: '#e9efed',
    brightBlack: '#66736f',
    brightRed: '#d2525b',
    brightGreen: '#2f965f',
    brightYellow: '#bd8100',
    brightBlue: '#2f7fcf',
    brightMagenta: '#b05caf',
    brightCyan: '#15968a',
    brightWhite: '#ffffff'
  }
} as const;

const appThemeColors: Record<ThemeMode, string> = {
  dark: '#ffffff',
  light: '#ffffff'
};

const terminal = new Terminal({
  cursorBlink: true,
  convertEol: true,
  fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
  fontSize: 14,
  lineHeight: 1.18,
  scrollback: 10000,
  scrollSensitivity: 1,
  theme: terminalThemes.dark
});

const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(terminalHost);
terminal.attachCustomWheelEventHandler((event) => {
  event.preventDefault();
  event.stopPropagation();

  const direction = event.deltaY > 0 ? 1 : -1;
  const magnitude = event.deltaMode === WheelEvent.DOM_DELTA_LINE
    ? Math.abs(event.deltaY)
    : Math.max(1, Math.ceil(Math.abs(event.deltaY) / 40));
  terminal.scrollLines(direction * Math.min(24, magnitude));

  return false;
});

const fabPositionStorageKey = 'screen-plus:floating-button-position';
const themeStorageKey = 'screen-plus:theme';
const fabSize = 58;
const fabGap = 18;
const socketIdleReconnectMs = 90_000;
const viewportMetricTolerance = 1;
const terminalTouchScrollGuardMs = 220;
const terminalTapMoveTolerance = 8;
const terminalInertiaMinVelocity = 0.035;
const terminalInertiaFrictionMs = 360;
let socket: WebSocket | null = null;
let activeSession: ScreenSession | null = null;
let sessions: ScreenSession[] = [];
let ctrlActive = false;
let altActive = false;
let shiftActive = false;
let reconnecting = false;
let sessionRefreshTimer = 0;
let connectionHealthTimer = 0;
let lastSocketActivityAt = 0;
let reconnectAfterResume = false;
let authMode: 'setup' | 'login' = 'login';
let terminalStarted = false;
let isDraggingFab = false;
let fabDragMoved = false;
let fabPointerId: number | null = null;
let fabDragOffset = { x: 0, y: 0 };
let viewportSyncFrame = 0;
let pendingViewportForceFit = false;
let lastViewportMetrics: ViewportMetrics | null = null;
let terminalTouchScrollUntil = 0;
let postTouchFitTimer = 0;
let terminalTouchGesture: TerminalTouchGesture | null = null;
let terminalScreen: HTMLElement | null = null;
let terminalElement: HTMLElement | null = null;
let terminalSubrowOffset = 0;
let terminalInertiaFrame = 0;

function readStoredTheme(): ThemeMode {
  const saved = localStorage.getItem(themeStorageKey);
  if (saved === 'light' || saved === 'dark') return saved;

  return 'dark';
}

function applyTheme(mode: ThemeMode, persist = true) {
  shell.dataset.theme = mode;
  terminal.options.theme = terminalThemes[mode];
  document.documentElement.style.colorScheme = mode;
  themeColorMeta?.setAttribute('content', appThemeColors[mode]);
  appleStatusBarMeta?.setAttribute('content', 'default');
  themeToggle.setAttribute('aria-pressed', String(mode === 'light'));
  themeIcon.textContent = mode === 'light' ? '☾' : '☀';
  themeLabel.textContent = mode === 'light' ? '暗夜' : '白天';

  if (persist) {
    localStorage.setItem(themeStorageKey, mode);
  }
}

function fitTerminalNow() {
  try {
    fitAddon.fit();
    sendResize();
  } catch {
    // The terminal can briefly be hidden while the auth gate is settling.
  }
}

function fitTerminal() {
  requestAnimationFrame(fitTerminalNow);
}

function getViewportMetrics(): ViewportMetrics {
  const viewport = window.visualViewport;
  return {
    top: Math.max(0, Math.floor(viewport ? viewport.offsetTop : 0)),
    width: Math.max(1, Math.floor(viewport ? viewport.width : window.innerWidth)),
    height: Math.max(1, Math.floor(viewport ? viewport.height : window.innerHeight))
  };
}

function viewportMetricChanged(previous: number, next: number) {
  return Math.abs(previous - next) > viewportMetricTolerance;
}

function isTerminalTouchScrolling() {
  return performance.now() < terminalTouchScrollUntil;
}

function schedulePostTouchFit(delay = terminalTouchScrollGuardMs + 80) {
  window.clearTimeout(postTouchFitTimer);
  postTouchFitTimer = window.setTimeout(() => {
    const remainingGuardMs = terminalTouchScrollUntil - performance.now();
    if (remainingGuardMs > 0) {
      postTouchFitTimer = 0;
      schedulePostTouchFit(remainingGuardMs + 40);
      return;
    }

    postTouchFitTimer = 0;
    fitTerminalNow();
  }, delay);
}

function markTerminalTouchScroll() {
  terminalTouchScrollUntil = performance.now() + terminalTouchScrollGuardMs;
  schedulePostTouchFit();
}

function shouldUseNativeTerminalTouchScroll() {
  return window.matchMedia?.('(hover: none) and (pointer: coarse)').matches || navigator.maxTouchPoints > 0;
}

function touchPoint(event: TouchEvent) {
  return event.touches[0] || event.changedTouches[0] || null;
}

function terminalLineHeightPx() {
  const rowElement = terminalScreen?.querySelector<HTMLElement>('.xterm-rows > div');
  const measured = rowElement?.getBoundingClientRect().height || 0;
  const screenMeasured = terminalScreen ? terminalScreen.getBoundingClientRect().height / Math.max(1, terminal.rows) : 0;
  return measured || screenMeasured || 16;
}

function setTerminalSubrowOffset(value: number) {
  terminalSubrowOffset = value;
  if (terminalScreen) {
    terminalScreen.style.transform = value ? `translateY(${-value}px)` : '';
  }
}

function clearTerminalInertia() {
  if (terminalInertiaFrame) {
    window.cancelAnimationFrame(terminalInertiaFrame);
    terminalInertiaFrame = 0;
  }
}

function applyTerminalTouchDelta(deltaY: number) {
  const lineHeight = terminalLineHeightPx();
  let offset = terminalSubrowOffset + deltaY;
  let lines = 0;
  const previousViewportY = terminal.buffer.active.viewportY;

  if (Math.abs(offset) >= lineHeight) {
    lines = Math.trunc(offset / lineHeight);
    terminal.scrollLines(lines);
    offset -= lines * lineHeight;
  }

  const viewportY = terminal.buffer.active.viewportY;
  const maxViewportY = Math.max(0, terminal.buffer.active.baseY);
  const hitBoundary = (viewportY <= 0 && offset < 0)
    || (viewportY >= maxViewportY && offset > 0)
    || (lines !== 0 && viewportY === previousViewportY);
  if (hitBoundary) {
    offset = 0;
    clearTerminalInertia();
  }

  setTerminalSubrowOffset(offset);
}

function startTerminalInertia(velocity: number) {
  clearTerminalInertia();
  velocity = Math.max(-2.4, Math.min(2.4, velocity));

  let lastFrameAt = performance.now();
  const step = (now: number) => {
    const elapsed = Math.min(32, now - lastFrameAt);
    lastFrameAt = now;
    velocity *= Math.exp(-elapsed / terminalInertiaFrictionMs);

    if (Math.abs(velocity) < terminalInertiaMinVelocity) {
      setTerminalSubrowOffset(0);
      terminalInertiaFrame = 0;
      return;
    }

    applyTerminalTouchDelta(velocity * elapsed);
    terminalInertiaFrame = window.requestAnimationFrame(step);
  };

  terminalInertiaFrame = window.requestAnimationFrame(step);
}

function handleTerminalTouchStart(event: TouchEvent) {
  if (!shouldUseNativeTerminalTouchScroll()) return;

  const point = touchPoint(event);
  if (!point) return;

  clearTerminalInertia();
  const now = performance.now();
  terminalTouchGesture = {
    startX: point.clientX,
    startY: point.clientY,
    lastY: point.clientY,
    lastTime: now,
    moved: false,
    velocity: 0
  };
  setTerminalSubrowOffset(0);
  event.stopImmediatePropagation();
}

function handleTerminalTouchMove(event: TouchEvent) {
  if (!shouldUseNativeTerminalTouchScroll() || !terminalTouchGesture) return;

  const point = touchPoint(event);
  if (point) {
    const now = performance.now();
    const deltaX = Math.abs(point.clientX - terminalTouchGesture.startX);
    const deltaY = Math.abs(point.clientY - terminalTouchGesture.startY);
    if (deltaX > terminalTapMoveTolerance || deltaY > terminalTapMoveTolerance) {
      terminalTouchGesture.moved = true;
    }

    const movement = terminalTouchGesture.lastY - point.clientY;
    const elapsed = Math.max(1, now - terminalTouchGesture.lastTime);
    terminalTouchGesture.velocity = movement / elapsed;
    terminalTouchGesture.lastY = point.clientY;
    terminalTouchGesture.lastTime = now;

    if (terminalTouchGesture.moved) {
      applyTerminalTouchDelta(movement);
    }
  }

  markTerminalTouchScroll();
  if (terminalTouchGesture.moved) event.preventDefault();
  event.stopImmediatePropagation();
}

function handleTerminalTouchEnd(event: TouchEvent) {
  if (!shouldUseNativeTerminalTouchScroll() || !terminalTouchGesture) return;

  const shouldFocus = !terminalTouchGesture.moved;
  const velocity = terminalTouchGesture.velocity;
  terminalTouchGesture = null;
  schedulePostTouchFit(120);
  if (!shouldFocus && Math.abs(velocity) >= terminalInertiaMinVelocity) {
    startTerminalInertia(velocity);
  } else {
    setTerminalSubrowOffset(0);
  }
  event.stopImmediatePropagation();

  if (shouldFocus) {
    terminal.focus();
  }
}

function handleTerminalTouchCancel(event: TouchEvent) {
  if (!shouldUseNativeTerminalTouchScroll()) return;

  terminalTouchGesture = null;
  setTerminalSubrowOffset(0);
  schedulePostTouchFit(120);
  event.stopImmediatePropagation();
}

function bindTerminalViewportTouchScroll() {
  terminalElement = terminalHost.querySelector<HTMLElement>('.xterm');
  terminalScreen = terminalHost.querySelector<HTMLElement>('.xterm-screen');
  if (!terminalElement) return;

  terminalElement.addEventListener('touchstart', handleTerminalTouchStart, { capture: true, passive: true });
  terminalElement.addEventListener('touchmove', handleTerminalTouchMove, { capture: true, passive: false });
  terminalElement.addEventListener('touchend', handleTerminalTouchEnd, { capture: true, passive: true });
  terminalElement.addEventListener('touchcancel', handleTerminalTouchCancel, { capture: true, passive: true });
}

function resetTerminalView() {
  terminal.reset();
  terminal.clear();
  terminal.write('\x1b[H\x1b[2J');
}

function syncViewportSize(forceFit = false) {
  pendingViewportForceFit = pendingViewportForceFit || forceFit;
  if (viewportSyncFrame) return;

  viewportSyncFrame = window.requestAnimationFrame(() => {
    viewportSyncFrame = 0;
    const shouldForceFit = pendingViewportForceFit;
    pendingViewportForceFit = false;

    const metrics = getViewportMetrics();
    const previous = lastViewportMetrics;
    const sizeChanged = !previous
      || viewportMetricChanged(previous.width, metrics.width)
      || viewportMetricChanged(previous.height, metrics.height);
    const topChanged = !previous || viewportMetricChanged(previous.top, metrics.top);

    if (sizeChanged || topChanged) {
      document.documentElement.style.setProperty('--app-top', `${metrics.top}px`);
      document.documentElement.style.setProperty('--app-height', `${metrics.height}px`);
      lastViewportMetrics = metrics;

      if (isDraggingFab) {
        constrainFabPosition();
      } else {
        restoreFabPosition();
      }
    }

    if (!sizeChanged && !shouldForceFit) return;

    if (isTerminalTouchScrolling()) {
      schedulePostTouchFit();
      return;
    }

    fitTerminalNow();
  });
}

function sendResize() {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({
    type: 'resize',
    cols: terminal.cols,
    rows: terminal.rows
  }));
}

async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(withBasePath(url), {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    if (response.status === 401 && !url.startsWith('/api/auth/')) {
      requireLogin(body.error || response.statusText, Boolean(body.setupRequired));
    }
    throw new Error(body.error || response.statusText);
  }

  return response.json();
}

function renderAuthGate(status: AuthStatusResponse) {
  authMode = status.setupRequired ? 'setup' : 'login';
  authGate.dataset.visible = status.authenticated ? 'false' : 'true';
  authTitle.textContent = status.setupRequired ? '设置访问密码' : '登录';
  authSubmit.textContent = status.setupRequired ? '保存并进入' : '进入';
  authPassword.autocomplete = status.setupRequired ? 'new-password' : 'current-password';
  authPassword.value = '';
  authMessage.textContent = '';
  authUsername.value = status.username || authUsername.value || 'admin';

  if (!status.authenticated) {
    updateSessionChip(status.setupRequired ? '需要设置密码' : '需要登录');
    requestAnimationFrame(() => authPassword.focus());
  }
}

function startTerminalSession() {
  if (terminalStarted) return;

  terminalStarted = true;
  fitTerminal();
  openDefaultSession();
}

async function loadAuthStatus() {
  const status = await api<AuthStatusResponse>('/api/auth/status');
  renderAuthGate(status);
  if (status.authenticated) startTerminalSession();
}

async function submitAuth() {
  const username = authUsername.value.trim();
  const password = authPassword.value;
  const url = authMode === 'setup' ? '/api/auth/setup' : '/api/auth/login';

  authSubmit.disabled = true;
  authMessage.textContent = authMode === 'setup' ? '正在保存' : '正在登录';

  try {
    const status = await api<AuthStatusResponse>(url, {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    renderAuthGate(status);
    startTerminalSession();
  } catch (error) {
    authMessage.textContent = error instanceof Error ? error.message : '认证失败';
    authPassword.select();
  } finally {
    authSubmit.disabled = false;
  }
}

function requireLogin(message = '需要重新登录', setupRequired = false) {
  terminalStarted = false;
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  activeSession = null;
  renderAuthGate({
    authenticated: false,
    setupRequired,
    username: authUsername.value || null
  });
  authMessage.textContent = message;
  resetTerminalView();
}

function setMenuOpen(open: boolean) {
  shell.dataset.menuOpen = String(open);
  fab.setAttribute('aria-expanded', String(open));
}

function setDrawerOpen(open: boolean) {
  shell.dataset.drawerOpen = String(open);
  if (open) refreshSessions();
}

function setKeyboardOpen(open: boolean) {
  shell.dataset.keyboardOpen = String(open);
  if (isDraggingFab) {
    constrainFabPosition();
  } else {
    restoreFabPosition();
  }
  fitTerminal();
}

function updateModifierButtons() {
  keyboard.querySelector<HTMLButtonElement>('[data-key="ctrl"]')?.setAttribute('aria-pressed', String(ctrlActive));
  keyboard.querySelector<HTMLButtonElement>('[data-key="alt"]')?.setAttribute('aria-pressed', String(altActive));
  keyboard.querySelector<HTMLButtonElement>('[data-key="shift"]')?.setAttribute('aria-pressed', String(shiftActive));
}

function applyModifiers(data: string) {
  let next = data;

  if (shiftActive) {
    const shiftedControls: Record<string, string> = {
      '\t': '\x1b[Z',
      '\x1b[A': '\x1b[1;2A',
      '\x1b[B': '\x1b[1;2B',
      '\x1b[C': '\x1b[1;2C',
      '\x1b[D': '\x1b[1;2D'
    };
    const shiftedCharacters: Record<string, string> = {
      '`': '~',
      '1': '!',
      '2': '@',
      '3': '#',
      '4': '$',
      '5': '%',
      '6': '^',
      '7': '&',
      '8': '*',
      '9': '(',
      '0': ')',
      '-': '_',
      '=': '+',
      '[': '{',
      ']': '}',
      '\\': '|',
      ';': ':',
      "'": '"',
      ',': '<',
      '.': '>',
      '/': '?'
    };

    if (shiftedControls[next]) {
      next = shiftedControls[next];
    } else if (next.length === 1 && /[a-z]/.test(next)) {
      next = next.toUpperCase();
    } else if (next.length === 1 && shiftedCharacters[next]) {
      next = shiftedCharacters[next];
    }
  }

  if (ctrlActive && next.length === 1) {
    const lower = next.toLowerCase();
    if (lower >= 'a' && lower <= 'z') next = String.fromCharCode(lower.charCodeAt(0) - 96);
    if (next === ' ') next = '\x00';
    if (next === '[') next = '\x1b';
    if (next === '\\') next = '\x1c';
    if (next === ']') next = '\x1d';
    if (next === '^') next = '\x1e';
    if (next === '_') next = '\x1f';
  }

  if (altActive) next = `\x1b${next}`;
  return next;
}

function sendInput(data: string) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    ensureActiveConnection('resume');
    return;
  }
  const modifiedData = applyModifiers(data);
  const hadModifier = ctrlActive || altActive || shiftActive;
  ctrlActive = false;
  altActive = false;
  shiftActive = false;
  if (hadModifier) updateModifierButtons();

  socket.send(JSON.stringify({ type: 'input', data: modifiedData }));
  terminal.focus();
}

function updateSessionChip(message?: string) {
  if (message) {
    sessionChip.textContent = message;
    return;
  }

  if (!activeSession) {
    sessionChip.textContent = '未连接';
    return;
  }

  sessionChip.textContent = activeSession.name;
}

function renderSessions() {
  drawerMeta.textContent = sessions.length ? `${sessions.length} 个会话` : '暂无会话';

  if (!sessions.length) {
    sessionList.innerHTML = '<div class="empty-state">没有找到 screen 会话</div>';
    return;
  }

  sessionList.replaceChildren(...sessions.map((session) => {
    const item = document.createElement('article');
    item.className = 'session-item';
    item.dataset.active = String(activeSession?.id === session.id);

    const title = document.createElement('button');
    title.type = 'button';
    title.className = 'session-main';
    title.innerHTML = `
      <span class="session-name">${session.name}</span>
      <span class="session-id">${session.id}</span>
    `;
    title.addEventListener('click', () => {
      connectSession(session, session.attached);
      setDrawerOpen(false);
    });

    const badge = document.createElement('span');
    badge.className = `session-badge session-badge-${session.status}`;
    badge.textContent = session.attached ? '占用' : session.status === 'dead' ? '失效' : '空闲';

    const renameButton = document.createElement('button');
    renameButton.type = 'button';
    renameButton.className = 'session-tool session-rename';
    renameButton.setAttribute('aria-label', `重命名会话 ${session.name}`);
    renameButton.textContent = '✎';
    renameButton.addEventListener('click', (event) => {
      event.stopPropagation();
      renameSession(session);
    });

    const closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'session-tool session-close';
    closeButton.setAttribute('aria-label', `关闭会话 ${session.name}`);
    closeButton.textContent = '×';
    closeButton.addEventListener('click', (event) => {
      event.stopPropagation();
      closeSession(session);
    });

    item.append(title, badge, renameButton, closeButton);
    return item;
  }));
}

async function refreshSessions() {
  try {
    const response = await api<SessionsResponse>('/api/sessions');
    sessions = response.sessions;
    const freshActive = activeSession ? sessions.find((session) => session.id === activeSession?.id) : null;
    if (freshActive) activeSession = freshActive;
    renderSessions();
    updateSessionChip();
  } catch (error) {
    drawerMeta.textContent = error instanceof Error ? error.message : '读取失败';
  }
}

async function reloadSessions() {
  const response = await api<SessionsResponse>('/api/sessions');
  sessions = response.sessions;
  const freshActive = activeSession ? sessions.find((session) => session.id === activeSession?.id) : null;
  if (freshActive) activeSession = freshActive;
  renderSessions();
  updateSessionChip();
  return response;
}

function selectFallbackSession(closedSessionId: string, previousSessions = sessions) {
  const closedIndex = previousSessions.findIndex((session) => session.id === closedSessionId);
  const orderedCandidates = closedIndex >= 0
    ? [...previousSessions.slice(closedIndex + 1), ...previousSessions.slice(0, closedIndex)]
    : previousSessions;
  const freshById = new Map(sessions.map((session) => [session.id, session]));
  const candidates = orderedCandidates
    .map((session) => freshById.get(session.id))
    .filter((session): session is ScreenSession => Boolean(session) && session.id !== closedSessionId && session.status !== 'dead');

  return candidates.find((session) => !session.attached)
    || candidates[0]
    || null;
}

function websocketUrl(session: ScreenSession, force: boolean) {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams({
    session: session.id,
    force: force ? '1' : '0',
    cols: String(terminal.cols || 120),
    rows: String(terminal.rows || 32)
  });
  return `${protocol}//${window.location.host}${withBasePath('/term')}?${params.toString()}`;
}

function ensureActiveConnection(reason = 'resume') {
  if (!terminalStarted || !activeSession) return;
  if (document.visibilityState === 'hidden') return;
  if (reconnecting || reconnectAfterResume) return;

  const stale = lastSocketActivityAt > 0 && Date.now() - lastSocketActivityAt > socketIdleReconnectMs;
  const closed = !socket || socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED;
  if (!closed && socket.readyState === WebSocket.OPEN && !stale) return;

  reconnectAfterResume = true;
  const session = activeSession;
  updateSessionChip(reason === 'stale' ? '正在恢复连接' : '正在重新连接');
  window.setTimeout(() => {
    reconnectAfterResume = false;
    if (!terminalStarted || activeSession?.id !== session.id) return;
    connectSession(session, session.attached, { clear: false });
  }, 120);
}

function connectSession(session: ScreenSession, force = false, options: { clear?: boolean } = {}) {
  activeSession = session;
  reconnecting = true;
  reconnectAfterResume = false;
  lastSocketActivityAt = Date.now();
  updateSessionChip(force && session.attached ? `正在接管 ${session.name}` : `正在打开 ${session.name}`);
  renderSessions();

  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }

  if (options.clear !== false) resetTerminalView();
  fitTerminalNow();

  socket = new WebSocket(websocketUrl(session, force));

  socket.addEventListener('open', () => {
    reconnecting = false;
    lastSocketActivityAt = Date.now();
    updateSessionChip();
    fitTerminalNow();
    window.setTimeout(fitTerminalNow, 120);
    window.setTimeout(fitTerminalNow, 400);
    terminal.focus();
    refreshSessions();
  });

  socket.addEventListener('message', (event) => {
    lastSocketActivityAt = Date.now();
    if (typeof event.data === 'string') {
      terminal.write(event.data);
      return;
    }

    event.data.arrayBuffer().then((buffer: ArrayBuffer) => {
      terminal.write(new Uint8Array(buffer));
    });
  });

  socket.addEventListener('close', () => {
    if (reconnecting) return;
    lastSocketActivityAt = 0;
    updateSessionChip('连接已断开');
    refreshSessions();
  });

  socket.addEventListener('error', () => {
    lastSocketActivityAt = 0;
    updateSessionChip('连接失败');
  });
}

async function openDefaultSession() {
  updateSessionChip('正在选择默认会话');
  try {
    fitTerminalNow();
    const { session } = await api<SessionResponse>('/api/sessions/default', {
      method: 'POST',
      body: JSON.stringify({ cols: terminal.cols || 120, rows: terminal.rows || 32 })
    });
    activeSession = session;
    connectSession(session, false);
    await refreshSessions();
  } catch (error) {
    const message = error instanceof Error ? error.message : '默认会话创建失败';
    updateSessionChip(message);
    terminal.write(`\r\nscreen-plus: ${message}\r\n`);
  }
}

async function createNewSession() {
  try {
    fitTerminalNow();
    const { session } = await api<SessionResponse>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({ cols: terminal.cols || 120, rows: terminal.rows || 32 })
    });
    await refreshSessions();
    connectSession(session, false);
    setDrawerOpen(false);
  } catch (error) {
    drawerMeta.textContent = error instanceof Error ? error.message : '创建失败';
  }
}

async function closeSession(session: ScreenSession) {
  const confirmed = window.confirm(`关闭 screen 会话「${session.name}」？\\n会话中的进程会被终止。`);
  if (!confirmed) return;

  try {
    drawerMeta.textContent = `正在关闭 ${session.name}`;
    const closingActiveSession = activeSession?.id === session.id;
    const previousSessions = sessions.slice();
    if (closingActiveSession) {
      socket?.close();
      socket = null;
      activeSession = null;
      updateSessionChip('正在关闭当前会话');
    }

    await api<SessionResponse>(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
    await reloadSessions();

    if (closingActiveSession) {
      resetTerminalView();
      const nextSession = selectFallbackSession(session.id, previousSessions);
      if (nextSession) {
        connectSession(nextSession, nextSession.attached);
      } else {
        await openDefaultSession();
      }
    }
  } catch (error) {
    drawerMeta.textContent = error instanceof Error ? error.message : '关闭失败';
    if (!activeSession) updateSessionChip('关闭失败');
  }
}

async function renameSession(session: ScreenSession) {
  const nextName = window.prompt('新的会话名称', session.name)?.trim();
  if (!nextName || nextName === session.name) return;

  try {
    drawerMeta.textContent = `正在重命名 ${session.name}`;
    const { session: renamedSession } = await api<SessionResponse>(`/api/sessions/${encodeURIComponent(session.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: nextName })
    });

    if (activeSession?.id === session.id) {
      activeSession = renamedSession;
      updateSessionChip();
    }

    await refreshSessions();
  } catch (error) {
    drawerMeta.textContent = error instanceof Error ? error.message : '重命名失败';
  }
}

function keyboardReservedHeight() {
  return shell.dataset.keyboardOpen === 'true' ? keyboard.getBoundingClientRect().height : 0;
}

function clampFabPosition(left: number, top: number) {
  const shellRect = shell.getBoundingClientRect();
  const viewportWidth = shellRect.width || window.innerWidth;
  const viewportHeight = shellRect.height || window.innerHeight;
  const maxLeft = Math.max(fabGap, viewportWidth - fabSize - fabGap);
  const maxTop = Math.max(fabGap, viewportHeight - keyboardReservedHeight() - fabSize - fabGap);

  return {
    left: Math.min(Math.max(fabGap, left), maxLeft),
    top: Math.min(Math.max(fabGap, top), maxTop)
  };
}

function applyFabPosition(left: number, top: number, persist = true) {
  const next = clampFabPosition(left, top);
  fab.style.left = `${next.left}px`;
  fab.style.top = `${next.top}px`;
  fab.style.right = 'auto';
  fab.style.bottom = 'auto';
  quickMenu.style.left = `${next.left}px`;
  quickMenu.style.top = `${next.top}px`;
  quickMenu.style.right = 'auto';
  quickMenu.style.bottom = 'auto';

  if (persist) {
    localStorage.setItem(fabPositionStorageKey, JSON.stringify(next));
  }
}

function constrainFabPosition() {
  const rect = fab.getBoundingClientRect();
  applyFabPosition(rect.left || window.innerWidth - fabSize - fabGap, rect.top || window.innerHeight - fabSize - fabGap, true);
}

function restoreFabPosition() {
  const shellRect = shell.getBoundingClientRect();
  const fallback = {
    left: (shellRect.width || window.innerWidth) - fabSize - fabGap,
    top: (shellRect.height || window.innerHeight) - keyboardReservedHeight() - fabSize - fabGap
  };

  try {
    const saved = JSON.parse(localStorage.getItem(fabPositionStorageKey) || 'null');
    if (typeof saved?.left === 'number' && typeof saved?.top === 'number') {
      applyFabPosition(saved.left, saved.top, false);
      return;
    }
  } catch {
    localStorage.removeItem(fabPositionStorageKey);
  }

  applyFabPosition(fallback.left, fallback.top, false);
}

terminal.onData((data) => sendInput(data));
terminal.onResize(sendResize);

bindTerminalViewportTouchScroll();

fab.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;

  const rect = fab.getBoundingClientRect();
  isDraggingFab = true;
  fabDragMoved = false;
  fabPointerId = event.pointerId;
  fabDragOffset = {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
  try {
    fab.setPointerCapture(event.pointerId);
  } catch {
    // Synthetic pointer events in browser tests may not be capturable.
  }
  fab.classList.add('fab-dragging');
});

fab.addEventListener('pointermove', (event) => {
  if (!isDraggingFab || fabPointerId !== event.pointerId) return;

  const left = event.clientX - fabDragOffset.x;
  const top = event.clientY - fabDragOffset.y;
  if (Math.abs(left - fab.getBoundingClientRect().left) > 1 || Math.abs(top - fab.getBoundingClientRect().top) > 1) {
    fabDragMoved = true;
  }
  applyFabPosition(left, top, false);
});

fab.addEventListener('pointerup', (event) => {
  if (!isDraggingFab || fabPointerId !== event.pointerId) return;

  isDraggingFab = false;
  fabPointerId = null;
  try {
    fab.releasePointerCapture(event.pointerId);
  } catch {
    // Keep drag completion resilient if capture was not established.
  }
  fab.classList.remove('fab-dragging');
  constrainFabPosition();

  if (!fabDragMoved) {
    setMenuOpen(shell.dataset.menuOpen !== 'true');
  }
});

fab.addEventListener('pointercancel', (event) => {
  if (fabPointerId !== event.pointerId) return;

  isDraggingFab = false;
  fabPointerId = null;
  try {
    fab.releasePointerCapture(event.pointerId);
  } catch {
    // Keep drag cancellation resilient if capture was not established.
  }
  fab.classList.remove('fab-dragging');
  constrainFabPosition();
});
quickMenu.addEventListener('click', (event) => event.stopPropagation());
scrim.addEventListener('click', () => {
  setMenuOpen(false);
  setDrawerOpen(false);
});

document.querySelector('#openSessions')?.addEventListener('click', () => {
  setMenuOpen(false);
  setDrawerOpen(true);
});

document.querySelector('#toggleKeyboard')?.addEventListener('click', () => {
  setMenuOpen(false);
  setKeyboardOpen(shell.dataset.keyboardOpen !== 'true');
});

themeToggle.addEventListener('click', () => {
  const nextMode: ThemeMode = shell.dataset.theme === 'light' ? 'dark' : 'light';
  setMenuOpen(false);
  applyTheme(nextMode);
});

document.querySelector('#closeDrawer')?.addEventListener('click', () => setDrawerOpen(false));
document.querySelector('#refreshSessions')?.addEventListener('click', refreshSessions);
document.querySelector('#newSession')?.addEventListener('click', createNewSession);

authForm.addEventListener('submit', (event) => {
  event.preventDefault();
  submitAuth();
});

keyboard.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button[data-key]');
  if (!button) return;

  const key = button.dataset.key;
  const keyMap: Record<string, string> = {
    escape: '\x1b',
    dash: '-',
    up: '\x1b[A',
    down: '\x1b[B',
    right: '\x1b[C',
    left: '\x1b[D',
    tab: '\t'
  };

  if (key === 'ctrl') {
    ctrlActive = !ctrlActive;
    updateModifierButtons();
    terminal.focus();
    return;
  }

  if (key === 'alt') {
    altActive = !altActive;
    updateModifierButtons();
    terminal.focus();
    return;
  }

  if (key === 'shift') {
    shiftActive = !shiftActive;
    updateModifierButtons();
    terminal.focus();
    return;
  }

  if (key && keyMap[key]) sendInput(keyMap[key]);
});

window.addEventListener('resize', () => {
  syncViewportSize();
});
window.visualViewport?.addEventListener('resize', () => {
  syncViewportSize();
});
window.visualViewport?.addEventListener('scroll', () => {
  syncViewportSize();
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    syncViewportSize();
    ensureActiveConnection('resume');
  }
});

window.addEventListener('pageshow', () => {
  syncViewportSize();
  ensureActiveConnection('resume');
});

window.addEventListener('focus', () => {
  ensureActiveConnection('resume');
});

window.addEventListener('online', () => {
  ensureActiveConnection('resume');
});

sessionRefreshTimer = window.setInterval(() => {
  if (shell.dataset.drawerOpen === 'true') refreshSessions();
}, 5000);

connectionHealthTimer = window.setInterval(() => {
  if (document.visibilityState === 'visible') {
    ensureActiveConnection('stale');
  }
}, 15_000);

window.addEventListener('beforeunload', () => {
  window.clearInterval(sessionRefreshTimer);
  window.clearInterval(connectionHealthTimer);
  socket?.close();
});

applyTheme(readStoredTheme(), false);
registerServiceWorker();
syncViewportSize();
loadAuthStatus().catch((error) => {
  authGate.dataset.visible = 'true';
  authMessage.textContent = error instanceof Error ? error.message : '认证状态读取失败';
  updateSessionChip('认证状态读取失败');
});
