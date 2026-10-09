// The "conformance profile": the fixed values a host module under test is configured with.
// See ../README.md. Everything can be overridden with environment variables so the suite and the
// fake platform stay in step with however the module was started.
const env = (name, fallback) => process.env[name] ?? fallback;

export const profile = {
  /** Where the module's three endpoint groups are mounted, e.g. http://127.0.0.1:5000/hoc (no trailing slash). */
  baseUrl: () => {
    const v = process.env.HOC_CONFORMANCE_BASE_URL;
    if (!v) throw new Error("HOC_CONFORMANCE_BASE_URL is not set (the module's hoc/ prefix URL, e.g. http://127.0.0.1:5000/hoc)");
    return v.replace(/\/+$/, "");
  },
  /** Control URL of the running fake platform (run.mjs starts it and sets this). */
  platformControlUrl: () => {
    const v = process.env.HOC_CONFORMANCE_PLATFORM_URL;
    if (!v) throw new Error("HOC_CONFORMANCE_PLATFORM_URL is not set (run the suite through run.mjs, or start fake-platform/cli.mjs)");
    return v.replace(/\/+$/, "");
  },
  platformPort: () => Number(env("HOC_CONFORMANCE_PLATFORM_PORT", "4010")),
  platformBind: () => env("HOC_CONFORMANCE_PLATFORM_BIND", "127.0.0.1"),
  apiKey: () => env("HOC_CONFORMANCE_API_KEY", "conformance-host-api-key"),
  webhookSecret: () => env("HOC_CONFORMANCE_WEBHOOK_SECRET", "whsec_conformance"),
  hostId: () => env("HOC_CONFORMANCE_HOST_ID", "conformance"),
  tenantId: () => env("HOC_CONFORMANCE_TENANT_ID", "conformance-tenant"),
  /** True when the database behind the module is brand new, so default-settings checks are meaningful. */
  freshDb: () => env("HOC_CONFORMANCE_FRESH_DB", "") === "1",
};

/** The user directory the module's get_current_user / is_admin / find_users must implement. */
export const USERS = {
  admin: { id: "admin", name: "Ada Admin", admin: true },
  alice: { id: "alice", name: "Alice Owner" },
  bob: { id: "bob", name: "Bob Builder" },
  carol: { id: "carol", name: "Carol Customer" },
  dave: { id: "dave", name: "Dave Dev" },
  erin: { id: "erin+qa@example.com", name: "Erin Special" },
};

/** Name of the cookie that carries the test identity. */
export const SESSION_COOKIE = "hoc_user";
