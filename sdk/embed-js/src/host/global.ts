/**
 * Entry point for the drop-in `<script>` build (dist/embed.global.js, bundled by build.mjs) - attaches
 * `window.HandOfClient` for hosts with no JS bundler of their own. A host using a bundler should import
 * from "@handofclient/embed-js/host" directly instead of loading this file.
 */
import { configure, mount, HocMountError } from "./index.js";

declare global {
  interface Window {
    HandOfClient: { configure: typeof configure; mount: typeof mount; MountError: typeof HocMountError };
  }
}

window.HandOfClient = { configure, mount, MountError: HocMountError };
