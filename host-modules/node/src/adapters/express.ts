/**
 * Express adapter::
 *
 *     import { router } from "@handofclient/host/express";
 *     app.use("/hoc", router(hoc));          // before any body parser, or capture req.rawBody (see README)
 *
 * `getCurrentUser` receives the Express `req`, so whatever your session / auth middleware put on it is available.
 * No dependency on Express itself: the returned function is a plain `(req, res, next)` middleware.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HostModule } from "../core.js";
import { nodeHandler, type NodeHandlerOptions } from "./node.js";

export type { NodeHandlerOptions as ExpressRouterOptions } from "./node.js";

export function router(hoc: HostModule, opts: Omit<NodeHandlerOptions, "prefix"> = {}): (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) => void {
  const handle = nodeHandler(hoc, opts);
  return (req, res, next) => {
    handle(req, res).catch((e) => (next ? next(e) : undefined));
  };
}
