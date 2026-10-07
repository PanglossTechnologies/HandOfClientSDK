import type { UiReplyPayload, UiRequestPayload } from "../protocol.js";

/**
 * Minimal, dependency-free modal/toast/confirm renderer, used when a host does not pass its own
 * `onUi` handler to `mount()`. This is what keeps hoc:ui off the mandatory host-integration-cost list
 * (mount + tokenUrl endpoint + optional webhooks) per docs/postmessage-protocol.md section 5.10 - a
 * host gets a working, if plain, UI for free.
 */
export async function defaultUiHandler(request: UiRequestPayload): Promise<UiReplyPayload> {
  switch (request.kind) {
    case "modal":
      return showModal(request.options.title, request.options.body);
    case "toast":
      return showToast(request.options.message, request.options.durationMs ?? 4000);
    case "confirm":
      return showConfirm(request.options.title, request.options.message);
  }
}

function baseOverlayStyle(): Partial<CSSStyleDeclaration> {
  return {
    position: "fixed",
    inset: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "rgba(0, 0, 0, 0.4)",
    zIndex: "2147483647",
    fontFamily: "system-ui, sans-serif",
  };
}

function showModal(title: string | undefined, body: string): Promise<{ closed: true }> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    Object.assign(overlay.style, baseOverlayStyle());

    const box = document.createElement("div");
    Object.assign(box.style, {
      background: "white", color: "#111", borderRadius: "8px", padding: "20px 24px",
      maxWidth: "420px", boxShadow: "0 8px 30px rgba(0,0,0,0.25)",
    } as Partial<CSSStyleDeclaration>);

    if (title) {
      const heading = document.createElement("h3");
      heading.textContent = title;
      heading.style.marginTop = "0";
      box.appendChild(heading);
    }
    const message = document.createElement("p");
    message.textContent = body;
    box.appendChild(message);

    const closeButton = document.createElement("button");
    closeButton.textContent = "Close";
    Object.assign(closeButton.style, { marginTop: "12px" } as Partial<CSSStyleDeclaration>);
    closeButton.onclick = () => {
      overlay.remove();
      resolve({ closed: true });
    };
    box.appendChild(closeButton);

    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

function showToast(message: string, durationMs: number): Promise<{ shown: true }> {
  const toast = document.createElement("div");
  toast.textContent = message;
  Object.assign(toast.style, {
    position: "fixed", bottom: "24px", left: "50%", transform: "translateX(-50%)",
    background: "#1f2937", color: "white", padding: "10px 16px", borderRadius: "6px",
    fontFamily: "system-ui, sans-serif", fontSize: "14px", zIndex: "2147483647",
    boxShadow: "0 4px 14px rgba(0,0,0,0.3)",
  } as Partial<CSSStyleDeclaration>);
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), durationMs);
  return Promise.resolve({ shown: true });
}

function showConfirm(title: string | undefined, message: string): Promise<{ confirmed: boolean }> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    Object.assign(overlay.style, baseOverlayStyle());

    const box = document.createElement("div");
    Object.assign(box.style, {
      background: "white", color: "#111", borderRadius: "8px", padding: "20px 24px",
      maxWidth: "420px", boxShadow: "0 8px 30px rgba(0,0,0,0.25)",
    } as Partial<CSSStyleDeclaration>);

    if (title) {
      const heading = document.createElement("h3");
      heading.textContent = title;
      heading.style.marginTop = "0";
      box.appendChild(heading);
    }
    const text = document.createElement("p");
    text.textContent = message;
    box.appendChild(text);

    const buttonRow = document.createElement("div");
    Object.assign(buttonRow.style, { display: "flex", gap: "8px", justifyContent: "flex-end" } as Partial<CSSStyleDeclaration>);

    const cancelButton = document.createElement("button");
    cancelButton.textContent = "Cancel";
    cancelButton.onclick = () => {
      overlay.remove();
      resolve({ confirmed: false });
    };

    const confirmButton = document.createElement("button");
    confirmButton.textContent = "OK";
    confirmButton.onclick = () => {
      overlay.remove();
      resolve({ confirmed: true });
    };

    buttonRow.append(cancelButton, confirmButton);
    box.appendChild(buttonRow);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}
