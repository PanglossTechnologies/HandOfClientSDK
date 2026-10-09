/**
 * Fastify adapter::
 *
 *     import { plugin } from "@handofclient/host/fastify";
 *     await app.register(plugin(hoc), { prefix: "/hoc" });
 *
 * `getCurrentUser` receives the Fastify request. The plugin is encapsulated: the raw-body parser it installs
 * (the webhook signature is over the exact bytes) applies only under its prefix, not to the rest of your app.
 * No dependency on Fastify itself.
 */
import type { HostModule } from "../core.js";
import { RESPONSE_HEADERS, responseBody } from "../core.js";
import { DEFAULT_MAX_BODY_BYTES, decodePath, parseQuery } from "./node.js";

export interface FastifyPluginOptions {
  maxBodyBytes?: number;
}

export function plugin(hoc: HostModule, opts: FastifyPluginOptions = {}): (app: any, options: unknown, done: (err?: Error) => void) => void {
  const max = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  return (app, _options, done) => {
    app.removeAllContentTypeParsers();
    app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: max }, (_req: unknown, body: Buffer, next: (err: Error | null, body?: Buffer) => void) => next(null, body));
    app.route({
      method: ["GET", "POST", "PUT", "DELETE"],
      url: "/*",
      bodyLimit: max,
      handler: async (request: any, reply: any) => {
        const raw: string = request.raw.url ?? "/";
        const q = raw.indexOf("?");
        const pathname = q < 0 ? raw : raw.slice(0, q);
        const prefix: string = (app.prefix ?? "").replace(/\/+$/, "");
        const relative = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : pathname;
        const path = decodePath(relative);
        if (path === null) {
          return reply.code(400).headers(RESPONSE_HEADERS).send(Buffer.from('{"error":"invalid_request","message":"Malformed URL."}'));
        }
        const out = await hoc.handle({
          method: request.method,
          path,
          query: parseQuery(q < 0 ? "" : raw.slice(q)),
          headers: request.headers,
          body: Buffer.isBuffer(request.body) ? request.body : undefined,
          request,
        });
        return reply.code(out.status).headers(RESPONSE_HEADERS).send(responseBody(out));
      },
    });
    done();
  };
}
