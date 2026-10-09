// Iframe-mode fixture built with the real plugin SDK, so the handshake under test is the shipped one.
import { hoc } from "../src/plugin/index.js";

await hoc.init(async (ctx) => {
  document.body.innerHTML = `
    <p id="msg">IFRAME ${ctx.user.userId} host=${ctx.hostId} tenant=${ctx.tenantId} slot=${ctx.slotId} v=${ctx.version}</p>
    <button id="go-plain">plain</button>
    <button id="go-evil">evil</button>`;
  document.getElementById("go-plain")!.onclick = () => hoc.navigate("/plain");
  document.getElementById("go-evil")!.onclick = () => hoc.navigate("https://evil.example/pwned");
});
