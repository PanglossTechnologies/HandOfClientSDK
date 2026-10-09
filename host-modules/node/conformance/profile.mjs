// The conformance profile (see host-modules/conformance/README.md): fixed roster, cookie identity, fixed keys.
// Test configuration only - nothing here is for production.
import { HostModule, PlatformClient, SqlStorage } from "../dist/esm/index.js";

export const COOKIE = "hoc_user";
export const ROSTER = {
  admin: { id: "admin", name: "Ada Admin" },
  alice: { id: "alice", name: "Alice Owner" },
  bob: { id: "bob", name: "Bob Builder" },
  carol: { id: "carol", name: "Carol Customer" },
  dave: { id: "dave", name: "Dave Dev" },
  "erin+qa@example.com": { id: "erin+qa@example.com", name: "Erin Special" },
};

const env = (name, dflt) => process.env[name] ?? dflt;

/** The roster user named by the `hoc_user` cookie of a Node/Express/Fastify request, or null. */
export function userFromCookieHeader(header) {
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0 || part.slice(0, i).trim() !== COOKIE) continue;
    let value = part.slice(i + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      /* keep the raw value */
    }
    return Object.hasOwn(ROSTER, value) ? ROSTER[value] : null;
  }
  return null;
}

const isAdmin = (user) => user.id === "admin";
const findUsers = (query) => {
  const q = query.toLowerCase();
  return Object.values(ROSTER).filter((u) => u.id.toLowerCase().includes(q) || u.name.toLowerCase().includes(q));
};
const userExists = (id) => Object.hasOwn(ROSTER, id);

/** SQLite file by default; HOC_CONFORMANCE_DATABASE_URL=postgresql://... or mysql://... for the others. */
export async function makeStorage() {
  const url = process.env.HOC_CONFORMANCE_DATABASE_URL;
  if (!url) return SqlStorage.sqlite(env("HOC_CONFORMANCE_DB", "conformance.db"));
  if (/^postgres/i.test(url)) {
    const { default: pg } = await import("pg");
    return SqlStorage.postgres(new pg.Pool({ connectionString: url }));
  }
  if (/^mysql/i.test(url)) {
    const mysql = await import("mysql2/promise");
    return SqlStorage.mysql(mysql.createPool({ uri: url, charset: "utf8mb4" }));
  }
  throw new Error(`unsupported HOC_CONFORMANCE_DATABASE_URL ${url.split(":")[0]}`);
}

export async function buildModule(getCurrentUser, { explicitUserExists = true } = {}) {
  return new HostModule({
    storage: await makeStorage(),
    platform: new PlatformClient({
      baseUrl: `http://127.0.0.1:${env("HOC_CONFORMANCE_PLATFORM_PORT", "4010")}`,
      apiKey: env("HOC_CONFORMANCE_API_KEY", "conformance-host-api-key"),
      tenantId: env("HOC_CONFORMANCE_TENANT_ID", "conformance-tenant"),
    }),
    webhookSecret: env("HOC_CONFORMANCE_WEBHOOK_SECRET", "whsec_conformance"),
    getCurrentUser,
    isAdmin,
    findUsers,
    userExists: explicitUserExists ? userExists : undefined,
  });
}
