/**
 * Fires exactly once, after `timeoutMs`, unless cancelled first. Deliberately dumb - see
 * docs/postmessage-protocol.md section 4's "explicit non-heuristic rule": readiness is only ever
 * decided by an explicit hoc:ready/hoc:error signal or this timeout, never by iframe.onload, a render
 * count, or a MutationObserver (render heuristics produce false-positive timeouts; an explicit signal
 * plus a generous timeout does not).
 */
export class ReadyWatchdog {
  private timer: ReturnType<typeof setTimeout> | null;

  constructor(timeoutMs: number, onTimeout: () => void) {
    this.timer = setTimeout(onTimeout, timeoutMs);
  }

  cancel(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
