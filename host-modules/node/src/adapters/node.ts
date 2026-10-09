/**
 * Plain Node `http` adapter (also what the Express adapter is built on)::
 *
 *     http.createServer(nodeHandler(hoc, { prefix: "/hoc" })).listen(3000)
 *
 * Requests whose path does not start with `prefix` get a 404. Under Express, mount with `app.use("/hoc", ...)`
 * and leave `prefix` unset: Express has already removed the mount path from `req.url`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { RESPONSE_HEADERS, responseBody, type HocRequest, type HocResponse, type HostModule } from "../core.js";
import { defaultLogger } from "../logger.js";

/** The biggest request body accepted: the 2 MiB page snapshot plus the request text and JSON overhead. */
export const DEFAULT_MAX_BODY_BYTES = 3 * 1024 * 1024;

export interface NodeHandlerOptions {
  /** Mount path to strip, e.g. `/hoc`. Leave unset when the framework has already stripped it (Express `app.use`). */
  prefix?: string;
  maxBodyBytes?: number;
}

const tooLarge: HocResponse = { status: 413, payload: { error: "payload_too_large", message: "The request body is too large." } };
const badPath: HocResponse = { status: 400, payload: { error: "invalid_request", message: "Malformed URL." } };
const notFound: HocResponse = { status: 404, payload: { error: "not_found", message: "Not found." } };

/** `a=1&a=2&b=3` -> `{ a: ["1", "2"], b: ["3"] }` */
export function parseQuery(search: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of new URLSearchParams(search)) (out[k] ??= []).push(v);
  return out;
}

/** Percent-decodes a URL path; null when it is malformed. */
export function decodePath(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}

/** Write a {@link HocResponse} to a Node response. */
export function sendNode(res: ServerResponse, out: HocResponse): void {
  const body = responseBody(out);
  res.statusCode = out.status;
  for (const [k, v] of Object.entries(RESPONSE_HEADERS)) res.setHeader(k, v);
  res.setHeader("content-length", body.length);
  res.end(body);
}

/**
 * The raw request body. If a body parser already consumed the stream, the bytes come from `req.rawBody` (the usual
 * `verify` hook) or `req.body`; a parsed JSON object is re-serialised (fine for the API; webhook signatures need
 * the original bytes, so mount the module before any body parser, or capture `rawBody`).
 * Returns null when the body is larger than `max`.
 */
export async function readBody(req: IncomingMessage & { body?: unknown; rawBody?: unknown }, max: number): Promise<Buffer | null> {
  const given = req.rawBody ?? req.body;
  if (Buffer.isBuffer(req.rawBody)) return req.rawBody.length > max ? null : req.rawBody;
  if (req.readableEnded) {
    if (Buffer.isBuffer(given)) return given.length > max ? null : given;
    if (typeof given === "string") return Buffer.from(given, "utf8");
    if (typeof given === "object" && given !== null && Object.keys(given).length > 0) return Buffer.from(JSON.stringify(given), "utf8");
    return Buffer.alloc(0);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > max) {
      req.resume();
      return null;
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Serve one request. Never rejects: every failure becomes an HTTP response. */
export function nodeHandler(hoc: HostModule, opts: NodeHandlerOptions = {}): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const prefix = (opts.prefix ?? "").replace(/\/+$/, "");
  const max = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      let pathname = url.pathname;
      if (prefix) {
        if (pathname !== prefix && !pathname.startsWith(prefix + "/")) return sendNode(res, notFound);
        pathname = pathname.slice(prefix.length);
      }
      const path = decodePath(pathname);
      if (path === null) return sendNode(res, badPath);
      const body = await readBody(req, max);
      if (body === null) return sendNode(res, tooLarge);
      const hocReq: HocRequest = { method: req.method ?? "GET", path, query: parseQuery(url.search), headers: req.headers, body, request: req };
      sendNode(res, await hoc.handle(hocReq));
    } catch (e) {
      defaultLogger.error("node adapter failed", e);
      if (!res.headersSent) sendNode(res, { status: 500, payload: { error: "internal", message: "Internal error." } });
      else res.end();
    }
  };
}
