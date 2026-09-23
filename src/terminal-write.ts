import type { Terminal } from '@xterm/xterm';

export function writeTerminal(
  terminal: Pick<Terminal, 'write'>,
  data: string | Uint8Array,
  afterWrite: () => void
) {
  // xterm invokes write callbacks inside its parser loop. A resize there can
  // synchronously flush that same queue and discard or replay pending output.
  // Finish the current parser loop before restoring state or fitting the view.
  terminal.write(data, () => queueMicrotask(afterWrite));
}
