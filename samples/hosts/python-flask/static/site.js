// Configures embed.js and, on signed-in pages, asks the site which features apply to this page.
// Kept in a file (not inline) so the Content-Security-Policy needs no hash or nonce for it.
(function () {
  var me = document.currentScript;
  HandOfClient.configure({
    apiBaseUrl: me.dataset.apiBaseUrl,
    embedOrigin: me.dataset.embedOrigin,
    sitePrefix: "/hoc/", // where the host module is mounted; absolute so it works at any page depth
  });
  if (document.body.dataset.hoc === "on") {
    // Never throws. If nothing applies, or anything fails, the original page is shown.
    HandOfClient.autoMount({ timeoutMs: 1500 });
  }
})();
