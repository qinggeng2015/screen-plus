const BEGIN_SYNC = '\x1b[?2026h';
const END_SYNC = '\x1b[?2026l';

// Screen 4.x drops application synchronized-output markers. Collect nearby PTY
// writes before forwarding them, then protect both xterm painting and scrolling
// while it parses the batch. The idle deadline is a heuristic, not an application
// frame boundary; the hard deadline keeps continuous output responsive.
function createTerminalOutput({
  send,
  setTimeout: schedule = setTimeout,
  clearTimeout: cancel = clearTimeout,
  quietMs = 32,
  maxWaitMs = 64,
  maxBytes = 256 * 1024
}) {
  let pending = '';
  let boundary = 0;
  let state = 'ground';
  let stringKind = '';
  let csiPrefix = '';
  let csiIntermediates = '';
  let csiHasParameters = false;
  let csiParameterValue = 0;
  let csiParameterIndex = 0;
  let csiSubparameter = false;
  let csiHasSyncParameter = false;
  let nativeSync = false;
  let batchStartedInSync = false;
  let batchHasSync = false;
  let passthrough = false;
  let idleTimer = null;
  let deadlineTimer = null;
  let disposed = false;

  function clearTimers() {
    if (idleTimer !== null) cancel(idleTimer);
    if (deadlineTimer !== null) cancel(deadlineTimer);
    idleTimer = deadlineTimer = null;
  }

  function flushReady() {
    clearTimers();
    if (!boundary) return;
    const data = pending.slice(0, boundary);
    pending = pending.slice(boundary);
    boundary = 0;
    // Preserve genuine synchronization sent through Screen's DCS passthrough.
    // Adding an END_SYNC here would otherwise prematurely end the app's frame.
    const protect = !passthrough && !batchStartedInSync && !batchHasSync;
    send(protect ? BEGIN_SYNC + data + END_SYNC : data);
    passthrough = false;
    batchStartedInSync = nativeSync;
    batchHasSync = false;
  }

  function beginCsi() {
    state = 'csi';
    csiPrefix = csiIntermediates = '';
    csiHasParameters = csiSubparameter = csiHasSyncParameter = false;
    csiParameterValue = csiParameterIndex = 0;
  }

  function currentParameterIsSync() {
    // xterm's parser stores 32 main parameters; later parameters are ignored.
    return csiParameterIndex < 32 && csiParameterValue === 2026;
  }

  function readCode(code, char) {
    // CAN/SUB cancel an unfinished control sequence, just as in the VT parser.
    if (code === 0x18 || code === 0x1a || code === 0x9c) {
      state = 'ground';
      return;
    }
    // ESC ends OSC/DCS and starts another escape sequence. Keeping it in the
    // original string would miss an immediately following native sync marker.
    if (code === 0x1b) {
      state = 'escape';
      return;
    }
    if (code === 0x9b) {
      beginCsi();
      return;
    }
    if ([0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
      state = 'string';
      stringKind = code === 0x9d ? 'osc' : 'other';
      return;
    }
    if (code >= 0x80 && code <= 0x9f) {
      state = 'ground';
      return;
    }
    if (state === 'string') {
      if (stringKind === 'osc' && code === 7) state = 'ground';
      return;
    }
    if (state === 'escape') {
      if (char === '[') {
        beginCsi();
      } else if (']PX^_'.includes(char)) {
        state = 'string';
        stringKind = char === ']' ? 'osc' : 'other';
      } else if (code >= 0x20 && code <= 0x2f) {
        state = 'escapeIntermediate';
      } else if (code >= 0x30 && code <= 0x7e) {
        if (char === 'c') {
          nativeSync = false;
          batchHasSync = true;
        }
        state = 'ground';
      } else if (code >= 0xa0) {
        state = 'ground';
      }
      return;
    }
    if (state === 'escapeIntermediate') {
      if ((code >= 0x30 && code <= 0x7e) || code >= 0xa0) state = 'ground';
      return;
    }
    if (state === 'csi' || state === 'csiIntermediate' || state === 'csiIgnore') {
      if (code >= 0x40 && code <= 0x7e) {
        if (state === 'csi' && csiPrefix === '?' && (char === 'h' || char === 'l')
          && (csiHasSyncParameter || currentParameterIsSync())) {
          nativeSync = char === 'h';
          batchHasSync = true;
        } else if (state === 'csiIntermediate' && !csiPrefix && csiIntermediates === '!' && char === 'p') {
          // DECSTR resets xterm's private modes, including synchronized output.
          nativeSync = false;
          batchHasSync = true;
        }
        state = 'ground';
      } else if (state === 'csiIgnore') {
        // Invalid parameter ordering is ignored until the final byte.
      } else if (code >= 0x20 && code <= 0x2f) {
        state = 'csiIntermediate';
        if (csiIntermediates.length < 2) csiIntermediates += char;
      } else if (code >= 0x30 && code <= 0x3f) {
        if (state === 'csiIntermediate' || (code >= 0x3c && (csiPrefix || csiHasParameters))) {
          state = 'csiIgnore';
          return;
        }
        if (code >= 0x3c) {
          csiPrefix = char;
        } else {
          csiHasParameters = true;
          if (char === ';') {
            csiHasSyncParameter ||= currentParameterIsSync();
            csiParameterValue = 0;
            csiParameterIndex = Math.min(32, csiParameterIndex + 1);
            csiSubparameter = false;
          } else if (char === ':') {
            csiSubparameter = true;
          } else if (!csiSubparameter) {
            // Only equality with 2026 matters. Saturation bounds memory and
            // preserves arbitrarily long leading-zero parameters correctly.
            csiParameterValue = Math.min(2027, csiParameterValue * 10 + code - 0x30);
          }
        }
      } else if (code >= 0xa0) {
        state = 'ground';
      }
    }
  }

  function streamPending() {
    // WebSocket text encoding replaces an unpaired high surrogate with U+FFFD.
    // Even the memory fallback must retain that one code unit for the next push.
    const lastCode = pending.charCodeAt(pending.length - 1);
    const end = pending.length - (lastCode >= 0xd800 && lastCode <= 0xdbff ? 1 : 0);
    if (end) send(pending.slice(0, end));
    pending = pending.slice(end);
    passthrough = state !== 'ground' || pending.length > 0;
  }

  function push(data) {
    if (disposed || !data) return;
    const offset = pending.length;
    pending += data;
    for (let i = offset; i < pending.length; i += 1) {
      const code = pending.charCodeAt(i);
      readCode(code, pending[i]);
      // Never insert an escape sequence inside a VT token or a UTF-16 pair.
      if (state === 'ground' && !(code >= 0xd800 && code <= 0xdbff)) boundary = i + 1;
    }

    if (passthrough || Buffer.byteLength(pending) >= maxBytes) {
      flushReady();
      if (pending && (passthrough || Buffer.byteLength(pending) >= maxBytes)) {
        // An oversized/incomplete OSC/DCS cannot be wrapped safely. Stream it
        // unchanged until its terminator arrives instead of growing memory or
        // injecting control bytes into its payload.
        streamPending();
      }
    }
    if (!pending) return;
    if (idleTimer !== null) cancel(idleTimer);
    idleTimer = schedule(flushReady, quietMs);
    if (deadlineTimer === null) deadlineTimer = schedule(flushReady, maxWaitMs);
  }

  return {
    push,
    flush() {
      flushReady();
      if (pending) streamPending();
    },
    dispose() {
      disposed = true;
      clearTimers();
      pending = '';
    }
  };
}

module.exports = { createTerminalOutput };
