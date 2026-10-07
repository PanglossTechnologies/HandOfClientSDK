import { createClient, type Client } from "@connectrpc/connect";
import { createGrpcWebTransport } from "@connectrpc/connect-web";
import { AuditLog } from "@handofclient/gen-ts/handofclient/v1/audit_log_connect";
import { EgressProxy } from "@handofclient/gen-ts/handofclient/v1/egress_proxy_connect";
import { Entitlement } from "@handofclient/gen-ts/handofclient/v1/entitlement_connect";
import { PackageRegistry } from "@handofclient/gen-ts/handofclient/v1/package_registry_connect";
import { TenantStorage } from "@handofclient/gen-ts/handofclient/v1/tenant_storage_connect";
import { TokenService } from "@handofclient/gen-ts/handofclient/v1/token_service_connect";
import { authInterceptor } from "./authInterceptor.js";
import type { TokenProvider } from "./tokenProvider.js";

export interface HocClientOptions {
  /** Platform API base URL, e.g. https://api.handofclient.com. */
  baseUrl: string;
  /** Bearer-token source for EmbedJwt-gated RPCs (calls made from inside a plugin iframe). Omit for a
   * host-backend-only client that never presents an embed token. */
  tokenProvider?: TokenProvider;
  /** x-api-key value for HostApiKey/SuperAdminKey-gated RPCs (registry management, audit query,
   * entitlement admin - calls made from a host's own backend). Omit for a plugin-side client. */
  apiKey?: string;
  /** Override fetch (tests, non-global-fetch runtimes). Defaults to global fetch. */
  fetch?: typeof fetch;
}

export interface HocClient {
  packageRegistry: Client<typeof PackageRegistry>;
  tokenService: Client<typeof TokenService>;
  entitlement: Client<typeof Entitlement>;
  tenantStorage: Client<typeof TenantStorage>;
  egressProxy: Client<typeof EgressProxy>;
  auditLog: Client<typeof AuditLog>;
}

/**
 * Builds the six typed Platform API clients, all sharing one transport and
 * one auth interceptor (token injection + single-retry refresh - see
 * authInterceptor.ts). This is the `hoc.api` surface referenced in the
 * plugin-side SDK (task C3) and the entry point for the standalone
 * @handofclient/api package.
 */
export function createHocClient(options: HocClientOptions): HocClient {
  // Neither tokenProvider nor apiKey is required: a caller that only ever hits Public RPCs (e.g.
  // GetActiveVersion, called anonymously by embed.js on the host page) needs no credential at all.

  // grpc-web, not the Connect protocol: ASP.NET Core's Grpc.AspNetCore has
  // no server-side Connect-protocol implementation (no "connect-dotnet"
  // exists), only real gRPC and grpc-web (via Grpc.AspNetCore.Web). See
  // services/platform's Program.cs for the matching server-side
  // AddGrpcWeb()/UseGrpcWeb() setup this transport talks to.
  const transport = createGrpcWebTransport({
    baseUrl: options.baseUrl,
    fetch: options.fetch,
    interceptors: [authInterceptor({ tokenProvider: options.tokenProvider, apiKey: options.apiKey })],
  });

  return {
    packageRegistry: createClient(PackageRegistry, transport),
    tokenService: createClient(TokenService, transport),
    entitlement: createClient(Entitlement, transport),
    tenantStorage: createClient(TenantStorage, transport),
    egressProxy: createClient(EgressProxy, transport),
    auditLog: createClient(AuditLog, transport),
  };
}
