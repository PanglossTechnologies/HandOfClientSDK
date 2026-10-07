import { type Envelope, isEnvelope, makeEnvelope } from "./protocol.js";

export interface ChannelTarget {
  window: Window;
  /** The postMessage targetOrigin. "*" is only ever correct for the plugin side's very first
   * hoc:hello, before it has learned (and pinned) the host's real origin - see
   * docs/postmessage-protocol.md section 3. Every other message on either side targets a specific,
   * known origin. */
  origin: string;
}

type NotificationHandler<T> = (payload: T, event: MessageEvent) => void;
type RequestHandler<TReq, TRes> = (payload: TReq, event: MessageEvent) => TRes | Promise<TRes>;

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * Shared request/reply/notification plumbing for both halves of the protocol. Origin validation is
 * intentionally injected rather than hard-coded here: the host side checks against one fixed embed
 * origin, while the plugin side pins to whichever origin delivered its first valid hoc:init (see
 * docs/postmessage-protocol.md section 3) - two different policies over the same wire mechanics.
 */
export class PostMessageChannel {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notificationHandlers = new Map<string, NotificationHandler<any>>();
  private readonly requestHandlers = new Map<string, RequestHandler<any, any>>();
  private readonly listener: (event: MessageEvent) => void;

  constructor(
    private readonly getTarget: () => ChannelTarget | null,
    private readonly validateIncoming: (event: MessageEvent) => boolean,
  ) {
    this.listener = (event: MessageEvent) => this.handleMessage(event);
    window.addEventListener("message", this.listener);
  }

  send<T>(type: string, payload: T, replyTo?: string): void {
    const target = this.getTarget();
    if (!target) return;
    target.window.postMessage(makeEnvelope(type, payload, replyTo), target.origin);
  }

  request<TReq, TRes>(type: string, payload: TReq, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<TRes> {
    const target = this.getTarget();
    if (!target) return Promise.reject(new Error(`No message target available for request "${type}"`));

    const envelope = makeEnvelope(type, payload);
    return new Promise<TRes>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(envelope.msgId);
        reject(new Error(`Request "${type}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(envelope.msgId, { resolve: resolve as (p: unknown) => void, reject, timer });
      target.window.postMessage(envelope, target.origin);
    });
  }

  onNotification<T>(type: string, handler: NotificationHandler<T>): void {
    this.notificationHandlers.set(type, handler);
  }

  /** Registers a handler for an incoming request; its return value (or resolved value) is
   * automatically posted back as the reply envelope. */
  onRequest<TReq, TRes>(type: string, handler: RequestHandler<TReq, TRes>): void {
    this.requestHandlers.set(type, handler);
  }

  dispose(): void {
    window.removeEventListener("message", this.listener);
    for (const { timer, reject } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("Channel disposed"));
    }
    this.pending.clear();
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    if (!this.validateIncoming(event)) return;
    if (!isEnvelope(event.data)) return;
    const envelope = event.data as Envelope;

    if (envelope.replyTo) {
      const pending = this.pending.get(envelope.replyTo);
      if (!pending) return; // reply to a request we no longer care about (timed out, disposed)
      clearTimeout(pending.timer);
      this.pending.delete(envelope.replyTo);
      pending.resolve(envelope.payload);
      return;
    }

    const requestHandler = this.requestHandlers.get(envelope.type);
    if (requestHandler) {
      const result = await requestHandler(envelope.payload, event);
      this.send(envelope.type, result, envelope.msgId);
      return;
    }

    const notificationHandler = this.notificationHandlers.get(envelope.type);
    notificationHandler?.(envelope.payload, event);
  }
}
