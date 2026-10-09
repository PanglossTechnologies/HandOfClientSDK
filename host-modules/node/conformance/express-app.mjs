// Express conformance app: node conformance/express-app.mjs --port 5000 (db: HOC_CONFORMANCE_DB)
import express from "express";
import { router } from "../dist/esm/adapters/express.js";
import { buildModule, userFromCookieHeader } from "./profile.mjs";

const port = Number(process.argv[process.argv.indexOf("--port") + 1] || 5000);
const hoc = await buildModule((req) => userFromCookieHeader(req.headers.cookie));
const app = express();
app.use("/hoc", router(hoc));
app.listen(port, "127.0.0.1");
