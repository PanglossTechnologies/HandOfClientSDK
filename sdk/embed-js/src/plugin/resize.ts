import { PostMessageChannel } from "../channel.js";
import { MessageType, type ResizePayload } from "../protocol.js";

/**
 * Observes `element`'s content height and sends hoc:resize, coalesced to at most one message per
 * animation frame - ResizeObserver can fire many times per frame during a layout thrash, and posting
 * once per intermediate value is wasteful (see docs/postmessage-protocol.md section 5.5).
 */
export function startAutoResize(channel: PostMessageChannel, element: HTMLElement): () => void {
  let scheduled = false;
  let lastHeight = -1;

  const flush = () => {
    scheduled = false;
    const height = Math.ceil(element.getBoundingClientRect().height);
    if (height === lastHeight) return;
    lastHeight = height;
    channel.send<ResizePayload>(MessageType.Resize, { height });
  };

  const observer = new ResizeObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(flush);
  });
  observer.observe(element);

  return () => observer.disconnect();
}
