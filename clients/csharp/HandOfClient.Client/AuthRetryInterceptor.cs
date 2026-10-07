using Grpc.Core;
using Grpc.Core.Interceptors;

namespace HandOfClient.Client;

/// <summary>
/// Retries a unary call once, after forcing a token refresh, when the
/// server returns Unauthenticated. Token injection itself happens via
/// CallCredentials.FromInterceptor (see HocClient), which re-reads
/// ITokenProvider.GetTokenAsync on every attempt including the retry - this
/// interceptor only owns the retry-on-401 decision, since gRPC's built-in
/// retry policy would resend the same (stale) credentials.
///
/// Only unary calls are retried: TenantStorage.WriteFile's request stream
/// is single-consume and cannot be safely replayed once the caller has
/// started sending chunks - matches the client-side wrapper (clients/ts).
/// </summary>
public sealed class AuthRetryInterceptor(ITokenProvider tokenProvider) : Interceptor
{
    public override AsyncUnaryCall<TResponse> AsyncUnaryCall<TRequest, TResponse>(
        TRequest request,
        ClientInterceptorContext<TRequest, TResponse> context,
        AsyncUnaryCallContinuation<TRequest, TResponse> continuation)
    {
        var current = continuation(request, context);

        async Task<TResponse> InvokeWithRetryAsync()
        {
            try
            {
                return await current.ResponseAsync.ConfigureAwait(false);
            }
            catch (RpcException ex) when (ex.StatusCode == StatusCode.Unauthenticated)
            {
                current.Dispose();
                await tokenProvider.RefreshTokenAsync().ConfigureAwait(false);
                current = continuation(request, context);
                return await current.ResponseAsync.ConfigureAwait(false);
            }
        }

        var responseTask = InvokeWithRetryAsync();

        async Task<Metadata> HeadersAsync()
        {
            try
            {
                await responseTask.ConfigureAwait(false);
            }
            catch
            {
                // Still expose headers from whichever call ultimately ran.
            }
            return await current.ResponseHeadersAsync.ConfigureAwait(false);
        }

        return new AsyncUnaryCall<TResponse>(
            responseTask,
            HeadersAsync(),
            () => current.GetStatus(),
            () => current.GetTrailers(),
            () => current.Dispose());
    }
}
