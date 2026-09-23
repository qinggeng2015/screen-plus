type InputSourceEvent = Event & {
  pointerType?: string;
  sourceCapabilities?: { firesTouchEvents?: boolean } | null;
};

export function bindTerminalInputGuard(host: HTMLElement) {
  let lastPointerType = '';

  function rememberPointer(event: PointerEvent) {
    // A compatibility event may call itself a mouse while retaining its touch
    // origin. Do not let that event unlock xterm's mousedown focus handler.
    if ((event as InputSourceEvent).sourceCapabilities?.firesTouchEvents === true) {
      lastPointerType = 'touch';
    } else if (event.pointerType) {
      lastPointerType = event.pointerType;
    }
  }

  function rememberTouch() {
    // Older browsers do not expose PointerEvent or InputDeviceCapabilities.
    lastPointerType = 'touch';
  }

  function guardMouseFocus(event: MouseEvent) {
    const sourceEvent = event as InputSourceEvent;
    const firesTouchEvents = sourceEvent.sourceCapabilities?.firesTouchEvents;
    const pointerType = sourceEvent.pointerType;
    const explicitlyTouch = firesTouchEvents === true || pointerType === 'touch' || pointerType === 'pen';

    if (!explicitlyTouch) {
      // Positive mouse evidence takes precedence over an earlier touch. A pen
      // also reports firesTouchEvents=false, so retain its pointerdown evidence
      // until a real mouse pointerdown or an explicit mouse event replaces it.
      if (pointerType === 'mouse' || (firesTouchEvents === false && lastPointerType !== 'pen')) {
        lastPointerType = 'mouse';
        return;
      }
      if (lastPointerType !== 'touch' && lastPointerType !== 'pen') return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
  }

  host.addEventListener('pointerdown', rememberPointer, { capture: true });
  host.addEventListener('touchstart', rememberTouch, { capture: true, passive: true });
  host.addEventListener('mousedown', guardMouseFocus, { capture: true });
  host.addEventListener('click', guardMouseFocus, { capture: true });
  host.addEventListener('contextmenu', guardMouseFocus, { capture: true });

  return {
    dispose() {
      host.removeEventListener('pointerdown', rememberPointer, { capture: true });
      host.removeEventListener('touchstart', rememberTouch, { capture: true });
      host.removeEventListener('mousedown', guardMouseFocus, { capture: true });
      host.removeEventListener('click', guardMouseFocus, { capture: true });
      host.removeEventListener('contextmenu', guardMouseFocus, { capture: true });
    }
  };
}
