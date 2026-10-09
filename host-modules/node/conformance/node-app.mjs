// Plain node:http conformance app (the adapter Express is built on): node conformance/node-app.mjs --port 5000
import http from "node:http";
import { nodeHandler } from "../dist/esm/adapters/node.js";
import { buildModule, userFromCookieHeader } from "./profile.mjs";

const port = Number(process.argv[process.argv.indexOf("--port") + 1] || 5000);
const hoc = await buildModule((req) => userFromCookieHeader(req.headers.cookie));
http.createServer(nodeHandler(hoc, { prefix: "/hoc" })).listen(port, "127.0.0.1");
