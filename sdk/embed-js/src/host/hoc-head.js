/* HandOfClient page-lookup guard. Inline this in <head>, BEFORE any body content (and before embed.js):
 *   <script> ...contents of dist/hoc-head.min.js... </script>
 * It hides the body until HandOfClient.autoMount() finishes (it calls window.__hocReveal), so a page a
 * feature overrides never flashes its original content. If embed.js never runs (blocked, offline, not
 * loaded) the body is revealed anyway after window.hocHeadTimeoutMs (default 5000; set it before this
 * snippet). Keep it above autoMount's timeoutMs + loadTimeoutMs (default 1500 + 3000). */
(function (w, d) {
  var s = d.createElement("style");
  s.id = "hoc-hide";
  s.textContent = "body{visibility:hidden!important}";
  d.head.appendChild(s);
  function reveal() {
    var e = d.getElementById("hoc-hide");
    if (e && e.parentNode) e.parentNode.removeChild(e);
  }
  w.__hocReveal = reveal;
  setTimeout(reveal, w.hocHeadTimeoutMs || 5000);
})(window, document);
