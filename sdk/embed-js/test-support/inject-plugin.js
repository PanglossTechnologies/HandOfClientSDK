// Inject-mode fixture: a plain module that takes the host's handoff (embed.js sets
// window.HandOfClientInject.pending right before this script runs) and edits the page in place.
const ctx = window.HandOfClientInject.pending;
const target = ctx.slotElement ?? document.getElementById("content");
target.textContent = `INJECTED ${ctx.featureId} user=${ctx.init.user.userId} host=${ctx.init.tenantContext.hostId} tenant=${ctx.init.tenantContext.tenantId}`;
