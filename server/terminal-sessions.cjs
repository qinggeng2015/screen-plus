const { randomUUID } = require('node:crypto');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');
const { normalizeTerminalSize } = require('./terminal-size.cjs');

const CHECKPOINT_BYTES = 128 * 1024;
const MAX_REPLAY_BYTES = 256 * 1024;
const PAUSE_BYTES = 1024 * 1024;
const RESUME_BYTES = 256 * 1024;

function sessionError(code, message) {
  return Object.assign(new Error(message), { code });
}

// SerializeAddon intentionally omits parser state. Keep the exact stream after
// each checkpoint, and only checkpoint at a complete parser/Unicode boundary.
// These internals are from the pinned headless version (also used by the addon).
function canCheckpoint(terminal) {
  const input = terminal._core._inputHandler;
  return input._parser.currentState === 0 && !input._stringDecoder._interim;
}

function attributes(data) {
  const values = [0];
  for (const [method, code] of [['isBold', 1], ['isDim', 2], ['isItalic', 3], ['isBlink', 5], ['isInverse', 7], ['isInvisible', 8], ['isStrikethrough', 9], ['isOverline', 53]]) {
    if (data[method]()) values.push(code);
  }
  if (data.isUnderline()) values.push(`4:${data.getUnderlineStyle() || 1}`);
  for (const [prefix, name] of [[38, 'Fg'], [48, 'Bg'], [58, 'Underline']]) {
    const color = data[`get${name}Color`]();
    if (data[`is${name}RGB`]?.() || data[`is${name}ColorRGB`]?.()) values.push(`${prefix};2;${color >>> 16 & 255};${color >>> 8 & 255};${color & 255}`);
    else if (data[`is${name}Palette`]?.() || data[`is${name}ColorPalette`]?.()) values.push(`${prefix};5;${color}`);
  }
  return `\x1b[${values.join(';')}m`;
}

function charsets(sets, level) {
  // Fingerprints of the bundled VT100 maps; output their ISO-2022 identifiers
  // rather than reinterpret already rendered Unicode cells during replay.
  const ids = { '£||': 'A', '£|¾|ij': '4', '||Ä': 'C', '£|à|°': 'R', '|à|â': 'Q', '|§|Ä': 'K', '£|§|°': 'Y', '|Ä|Æ': 'E', '£|§|¡': 'Z', '|É|Ä': 'H', 'ù|à|é': '=' };
  return ['(', ')', '*', '+'].map((prefix, index) => {
    const set = sets[index];
    const id = !set ? 'B' : set.q === '─' ? '0' : ids[[set['#'] || '', set['@'] || '', set['['] || ''].join('|')];
    if (!id) throw new Error('Unsupported terminal character set.');
    return '\x1b' + prefix + id;
  }).join('') + ['\x0f', '\x0e', '\x1bn', '\x1bo'][level || 0];
}

function cursorPosition(terminal, row, col, originOffset = terminal.modes.originMode ? terminal._core.buffer.scrollTop : 0) {
  let result = `\x1b[${row - originOffset + 1};${Math.min(col, terminal.cols - 1) + 1}H`;
  if (col >= terminal.cols) {
    // CUP cannot express the pending wrap after printing the final cell. Paint
    // that same cell once to recover the state without adding text or a line.
    const line = terminal.buffer.active.getLine(terminal.buffer.active.baseY + row);
    let index = terminal.cols - 1;
    let cell = line.getCell(index);
    if (cell.getWidth() === 0 && index) cell = line.getCell(--index);
    result = `\x1b[${row - originOffset + 1};${index + 1}H` + attributes(cell) + (cell.getChars() || ' ');
  }
  return result;
}

function serializeTerminal(terminal, serializer) {
  const buffer = terminal._core.buffer;
  let result = '\x1bc' + serializer.serialize();
  // Preserve DECSC/DECRC across reconnects. Curses apps may restore a cursor
  // saved before the browser disconnected; the serialize addon omits this.
  const savedRow = Math.max(0, Math.min(terminal.rows - 1, buffer.savedY - buffer.ybase));
  // The full region lets DECSC store the original absolute row even when the
  // application's current margins differ from its saved origin-mode margins.
  result += '\x1b[r' + `\x1b[?6${buffer.savedOriginMode ? 'h' : 'l'}`;
  result += charsets([], 0) + cursorPosition(terminal, savedRow, buffer.savedX, 0);
  result += attributes(buffer.savedCurAttrData);
  result += charsets(buffer.savedCharsets, buffer.savedGlevel);
  result += `\x1b[?7${buffer.savedWraparoundMode ? 'h' : 'l'}\x1b7`;
  result += '\x1b[?6l' + `\x1b[${buffer.scrollTop + 1};${buffer.scrollBottom + 1}r`;
  result += `\x1b[?7${terminal.modes.wraparoundMode ? 'h' : 'l'}`;
  if (terminal.modes.originMode) result += '\x1b[?6h';
  // Restoring a scroll region or origin mode homes the cursor. SerializeAddon
  // currently appends those after the content/cursor, so restore it once more.
  result += charsets([], 0) + cursorPosition(terminal, buffer.y, buffer.x);
  result += attributes(terminal._core._inputHandler._curAttrData);
  result += charsets(terminal._core._charsetService.charsets, terminal._core._charsetService.glevel);
  const encoding = terminal._core.mouseStateService.activeEncoding;
  if (encoding === 'SGR') result += '\x1b[?1006h';
  if (encoding === 'SGR_PIXELS') result += '\x1b[?1016h';
  // A native frame may span multiple reads. Never append an artificial END.
  if (terminal.modes.synchronizedOutputMode) result += '\x1b[?2026h';
  return result;
}

function createTerminalSessions({ spawn, shell, cwd, env, onExit = () => {} }) {
  const sessions = new Map();

  function metadata(session) {
    return {
      id: session.id,
      name: session.name,
      status: session.observer ? 'attached' : 'detached',
      attached: Boolean(session.observer),
      lastSeen: session.lastSeen,
      cols: session.terminal.cols,
      rows: session.terminal.rows
    };
  }

  function requireSession(id) {
    const session = sessions.get(id);
    if (!session || session.closed) throw sessionError('NOT_FOUND', 'Terminal session not found.');
    return session;
  }

  function enqueue(session, operation) {
    const result = session.queue.then(operation);
    session.queue = result.catch(() => {});
    return result;
  }

  function checkpoint(session) {
    if (!canCheckpoint(session.terminal)) return false;
    session.baseline = serializeTerminal(session.terminal, session.serializer);
    session.replay = [];
    session.replayBytes = 0;
    session.recoverable = true;
    return true;
  }

  function detachObserver(session, observer, reason) {
    if (session.observer !== observer) return;
    session.observer = null;
    observer.active = false;
    observer.onDetach?.(reason);
  }

  function create(name, size = {}) {
    const { cols, rows } = normalizeTerminalSize(size.cols, size.rows);
    const terminal = new Terminal({ cols, rows, scrollback: 10000, allowProposedApi: true, logLevel: 'off' });
    const serializer = new SerializeAddon();
    terminal.loadAddon(serializer);
    const childEnv = { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    delete childEnv.STY;
    delete childEnv.TMUX;
    delete childEnv.TMUX_PANE;
    let process;
    try {
      process = spawn(shell, ['-l'], { name: 'xterm-256color', cols, rows, cwd, env: childEnv });
    } catch (error) {
      terminal.dispose();
      throw error;
    }
    const session = {
      id: `term-${randomUUID()}`, name, process, terminal, serializer,
      observer: null, lastSeen: new Date().toISOString(), closed: false,
      queue: Promise.resolve(), queuedBytes: 0, paused: false,
      baseline: '\x1bc', replay: [], replayBytes: 0, recoverable: true,
      disposables: [], trailingSurrogate: ''
    };
    sessions.set(session.id, session);

    // An unattached application still needs terminal query responses (CPR/DA)
    // to make progress. When attached, the real browser owns these responses.
    session.disposables.push(terminal.onData(data => {
      if (!session.observer && !session.closed) process.write(data);
    }));
    session.disposables.push(process.onData(data => {
      if (session.closed || !data) return;
      data = session.trailingSurrogate + data;
      const finalCode = data.charCodeAt(data.length - 1);
      session.trailingSurrogate = finalCode >= 0xd800 && finalCode <= 0xdbff ? data.slice(-1) : '';
      if (session.trailingSurrogate) data = data.slice(0, -1);
      if (!data) return;
      const bytes = Buffer.byteLength(data);
      session.queuedBytes += bytes;
      if (!session.paused && session.queuedBytes >= PAUSE_BYTES) {
        session.paused = true;
        process.pause();
      }
      enqueue(session, async () => {
        if (session.closed) return;
        await new Promise(resolve => terminal.write(data, resolve));
        session.lastSeen = new Date().toISOString();
        session.replayBytes += bytes;
        if (session.recoverable) session.replay.push(data);
        if (session.replayBytes >= CHECKPOINT_BYTES || !session.recoverable) checkpoint(session);
        if (session.replayBytes > MAX_REPLAY_BYTES) {
          // A malicious or unfinished OSC/DCS cannot grow retained raw history
          // forever. Existing clients still receive every byte; new attaches
          // wait for a complete sequence instead of receiving a corrupt suffix.
          session.replay = [];
          session.replayBytes = 0;
          session.recoverable = false;
        }
        session.observer?.onData(data);
      }).finally(() => {
        session.queuedBytes -= bytes;
        if (session.paused && session.queuedBytes <= RESUME_BYTES && !session.closed) {
          session.paused = false;
          process.resume();
        }
      }).catch(() => {
        if (session.observer) detachObserver(session, session.observer, 'output-error');
      });
    }));
    session.disposables.push(process.onExit(event => {
      enqueue(session, () => finish(session, event)).catch(() => {});
    }));
    return metadata(session);
  }

  function finish(session, event) {
    if (session.closed) return;
    session.closed = true;
    sessions.delete(session.id);
    const current = session.observer;
    session.observer = null;
    try {
      if (current) {
        current.active = false;
        current.onExit?.(event);
      }
    } finally {
      for (const disposable of session.disposables) disposable.dispose();
      session.terminal.dispose();
      onExit(metadata(session), event);
    }
  }

  async function attach(id, options) {
    const session = requireSession(id);
    return enqueue(session, () => {
      requireSession(id);
      if (session.observer && !options.force) throw sessionError('ATTACHED', 'Terminal session is already attached.');
      // Prefer a fresh compact snapshot; when inside a CSI/OSC, the preceding
      // checkpoint plus its exact raw tail also preserves the parser prefix.
      checkpoint(session);
      if (!session.recoverable) throw sessionError('SNAPSHOT_PENDING', 'Waiting for an unfinished terminal control sequence. Please reconnect shortly.');
      if (session.observer) detachObserver(session, session.observer, 'taken-over');
      const observer = { ...options, active: true };
      session.observer = observer;
      try {
        observer.onSnapshot({
          data: session.baseline + session.replay.join(''),
          cols: session.terminal.cols,
          rows: session.terminal.rows
        });
      } catch (error) {
        detachObserver(session, observer, 'snapshot-error');
        throw error;
      }
      return {
        write(data) {
          if (observer.active && session.observer === observer && !session.closed) session.process.write(data);
        },
        resize(cols, rows) {
          return enqueue(session, () => {
            if (!observer.active || session.observer !== observer || session.closed) return;
            const size = normalizeTerminalSize(cols, rows);
            if (size.cols === session.terminal.cols && size.rows === session.terminal.rows) return;
            session.terminal.resize(size.cols, size.rows);
            session.process.resize(size.cols, size.rows);
            if (!checkpoint(session)) {
              // A raw suffix recorded at the previous width cannot be replayed
              // at the new width. Resume snapshot availability at the boundary.
              session.replay = [];
              session.replayBytes = 0;
              session.recoverable = false;
            }
          });
        },
        detach() {
          detachObserver(session, observer, 'disconnected');
        }
      };
    });
  }

  return {
    create,
    list: () => Array.from(sessions.values(), metadata),
    get: id => sessions.has(id) ? metadata(sessions.get(id)) : null,
    rename(id, name) {
      const session = requireSession(id);
      session.name = name;
      return metadata(session);
    },
    close(id) {
      const session = requireSession(id);
      session.process.kill();
      // Let queued xterm write callbacks finish before disposing its parser.
      return enqueue(session, () => finish(session, { exitCode: 0, signal: 15 }));
    },
    attach
  };
}

module.exports = { createTerminalSessions };
