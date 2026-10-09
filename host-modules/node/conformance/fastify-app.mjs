// Fastify conformance app: node conformance/fastify-app.mjs --port 5000 (db: HOC_CONFORMANCE_DB)
import Fastify from "fastify";
import { plugin } from "../dist/esm/adapters/fastify.js";
import { buildModule, userFromCookieHeader } from "./profile.mjs";

const port = Number(process.argv[process.argv.indexOf("--port") + 1] || 5000);
const hoc = await buildModule((req) => userFromCookieHeader(req.headers.cookie));
const app = Fastify();
await app.register(plugin(hoc), { prefix: "/hoc" });
await app.listen({ port, host: "127.0.0.1" });
