using Grpc.Core;
using Grpc.Core.Interceptors;
using Grpc.Net.Client;
using Grpc.Net.Client.Configuration;
using HandOfClient.V1;

namespace HandOfClient.Client;

public sealed class HocClientOptions
{
    /// <summary>Platform API base address, e.g. https://api.handofclient.com. Must be https in production.</summary>
    public required string BaseAddress { get; init; }

    /// <summary>Bearer-token source for EmbedJwt-gated RPCs (calls made from inside a plugin iframe -
    /// TenantStorage, EgressProxy, Entitlement.CheckFeatures/ReportUsage). Null for a host-backend-only
    /// client that never presents an embed token - see AuthPolicy.Methods.</summary>
    public ITokenProvider? TokenProvider { get; init; }

    /// <summary>x-api-key value for HostApiKey/SuperAdminKey-gated RPCs (registry management, audit
    /// query, entitlement admin - calls made from a host's own backend, never from inside a plugin
    /// iframe). Null for a plugin-side client that only ever presents an embed token.</summary>
    public string? ApiKey { get; init; }
}

/// <summary>
/// The six Platform API clients, sharing one GrpcChannel: CallCredentials
/// inject the bearer token asynchronously on every attempt,
/// AuthRetryInterceptor retries once on Unauthenticated after a forced
/// refresh, and a gRPC retry policy handles transient Unavailable
/// separately. This is what the generated HandOfClient.Client NuGet
/// package (task A4) wraps around the raw generated stubs.
/// </summary>
public sealed class HocClient : IDisposable
{
    private readonly GrpcChannel _channel;

    public PackageRegistry.PackageRegistryClient PackageRegistry { get; }
    public TokenService.TokenServiceClient TokenService { get; }
    public Entitlement.EntitlementClient Entitlement { get; }
    public TenantStorage.TenantStorageClient TenantStorage { get; }
    public EgressProxy.EgressProxyClient EgressProxy { get; }
    public AuditLog.AuditLogClient AuditLog { get; }

    public HocClient(HocClientOptions options)
    {
        // Neither is required: a caller that only ever hits Public RPCs (e.g. GetActiveVersion, called
        // anonymously by embed.js on the host page - see AuthPolicy.Methods) needs no credential at all.
        CallCredentials? callCredentials = null;
        if (options.TokenProvider is { } tokenProvider)
        {
            var bearer = CallCredentials.FromInterceptor(async (_, metadata) =>
            {
                var token = await tokenProvider.GetTokenAsync().ConfigureAwait(false);
                metadata.Add("Authorization", $"Bearer {token}");
            });
            callCredentials = bearer;
        }
        if (options.ApiKey is { } apiKey)
        {
            var keyCredentials = CallCredentials.FromInterceptor((_, metadata) =>
            {
                metadata.Add("x-api-key", apiKey);
                return Task.CompletedTask;
            });
            callCredentials = callCredentials is null ? keyCredentials : CallCredentials.Compose(callCredentials, keyCredentials);
        }

        ChannelCredentials channelCredentials = callCredentials is null
            ? new SslCredentials()
            : ChannelCredentials.Create(new SslCredentials(), callCredentials);

        _channel = GrpcChannel.ForAddress(options.BaseAddress, new GrpcChannelOptions
        {
            Credentials = channelCredentials,
            ServiceConfig = new ServiceConfig
            {
                MethodConfigs =
                {
                    new MethodConfig
                    {
                        Names = { MethodName.Default },
                        RetryPolicy = new RetryPolicy
                        {
                            MaxAttempts = 4,
                            InitialBackoff = TimeSpan.FromMilliseconds(200),
                            MaxBackoff = TimeSpan.FromSeconds(2),
                            BackoffMultiplier = 2,
                            RetryableStatusCodes = { StatusCode.Unavailable },
                        },
                    },
                },
            },
        });

        // Retry-on-Unauthenticated only makes sense for the bearer/embed-token flow - a rejected
        // x-api-key is a bad key, not something a refresh fixes.
        CallInvoker invoker = options.TokenProvider is { } tp
            ? _channel.Intercept(new AuthRetryInterceptor(tp))
            : _channel.CreateCallInvoker();

        PackageRegistry = new PackageRegistry.PackageRegistryClient(invoker);
        TokenService = new TokenService.TokenServiceClient(invoker);
        Entitlement = new Entitlement.EntitlementClient(invoker);
        TenantStorage = new TenantStorage.TenantStorageClient(invoker);
        EgressProxy = new EgressProxy.EgressProxyClient(invoker);
        AuditLog = new AuditLog.AuditLogClient(invoker);
    }

    public void Dispose() => _channel.Dispose();
}
