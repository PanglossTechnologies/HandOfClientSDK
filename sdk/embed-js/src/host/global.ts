/**
 * Entry point for the drop-in `<script>` build (dist/embed.global.js, bundled by build.mjs) - attaches
 * `window.HandOfClient` for hosts with no JS bundler of their own. A host using a bundler should import
 * from "@handofclient/embed-js/host" directly instead of loading this file.
 */
import { autoMount, captureSnapshot, configure, defineComponents, featureAdmin, features, HocMountError, mount, myFeatures, requestFeature } from "./index.js";

declare global {
  interface Window {
    HandOfClient: {
      configure: typeof configure;
      mount: typeof mount;
      autoMount: typeof autoMount;
      captureSnapshot: typeof captureSnapshot;
      features: typeof features;
      requestFeature: typeof requestFeature;
      myFeatures: typeof myFeatures;
      featureAdmin: typeof featureAdmin;
      defineComponents: typeof defineComponents;
      MountError: typeof HocMountError;
    };
  }
}

window.HandOfClient = { configure, mount, autoMount, captureSnapshot, features, requestFeature, myFeatures, featureAdmin, defineComponents, MountError: HocMountError };
defineComponents();
