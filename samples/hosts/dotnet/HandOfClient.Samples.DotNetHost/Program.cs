using System.Security.Cryptography;
using System.Text;
using HandOfClient.Client;
using HandOfClient.V1;
using NLog;
using NLog.Web;

var logger = LogManager.Setup().LoadConfigurationFromFile("NLog.config", optional: true).GetCurrentClassLogger();
try
{
    var builder = WebApplication.CreateBuilder(args);
    builder.Logging.ClearProviders();
    builder.Host.UseNLog();

    var app = builder.Build();
    var config = app.Configuration;
    var log = app.Logger;

    // The one required backend endpoint per docs/postmessage-protocol.md section 4 step 1: mints an
    // embed token by calling TokenService server-to-server with this host's own API key, never handing
    // that key to the browser. In a real host this would also validate the caller's own login session
    // (cookie/JWT/whatever the host already uses) before minting anything for them - this sample skips
    // that and always issues for the fixed demo user/tenant in config, since it has no login system of
    // its own to demonstrate.
    app.MapGet("/api/embed-token", async () =>
    {
        var apiBaseUrl = config["Platform:ApiBaseUrl"] ?? throw new InvalidOperationException("Platform:ApiBaseUrl not configured");
        var hostApiKey = config["Platform:HostApiKey"] ?? throw new InvalidOperationException(
            "Platform:HostApiKey not configured - see README.md Setup (dotnet user-secrets set Platform:HostApiKey ...)");

        using var client = new HocClient(new HocClientOptions { BaseAddress = apiBaseUrl, ApiKey = hostApiKey });
        try
        {
            var response = await client.TokenService.IssueEmbedTokenAsync(new IssueEmbedTokenRequest
            {
                HostApiKey = hostApiKey,
                TenantId = config["Demo:TenantId"] ?? "demo-tenant",
                UserId = config["Demo:UserId"] ?? "demo-user-1",
                SlotId = config["Demo:SlotId"] ?? "main-panel",
                PackageId = config["Demo:PackageId"] ?? "handofclient/hello-world",
            });
            log.LogInformation("Issued embed token for tenant={Tenant} package={Package}", config["Demo:TenantId"], config["Demo:PackageId"]);
            return Results.Ok(new
            {
                token = response.Token,
                expiresAt = response.ExpiresAt.ToDateTimeOffset().ToString("O"),
                userId = config["Demo:UserId"] ?? "demo-user-1",
                displayName = config["Demo:DisplayName"] ?? "Demo User",
            });
        }
        catch (Grpc.Core.RpcException ex)
        {
            log.LogError(ex, "IssueEmbedToken failed");
            return Results.Problem(detail: ex.Status.Detail, statusCode: 502);
        }
    });

    // Optional per docs/postmessage-protocol.md section 2 ("Host integration cost is deliberately three
    // things ... (3) optionally receive webhooks"). Verifies the HMAC-SHA256 signature so a
    // stranger who finds this URL can't inject fake activation-change events.
    app.MapPost("/webhooks/handofclient", async (HttpRequest request) =>
    {
        var webhookSecret = config["Platform:WebhookSecret"];
        if (string.IsNullOrEmpty(webhookSecret))
        {
            log.LogWarning("Received a webhook but Platform:WebhookSecret is not configured - rejecting");
            return Results.Problem(statusCode: 500, detail: "Webhook receiver not configured");
        }

        using var bodyStream = new MemoryStream();
        await request.Body.CopyToAsync(bodyStream);
        var body = bodyStream.ToArray();

        var signatureHeader = request.Headers["X-HandOfClient-Signature"].ToString();
        var expected = "sha256=" + Convert.ToHexString(
            HMACSHA256.HashData(Encoding.UTF8.GetBytes(webhookSecret), body)).ToLowerInvariant();

        if (!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(signatureHeader), Encoding.UTF8.GetBytes(expected)))
        {
            log.LogWarning("Rejected webhook delivery with an invalid signature");
            return Results.Unauthorized();
        }

        var eventType = request.Headers["X-HandOfClient-Event"].ToString();
        log.LogInformation("Received verified webhook {Event}: {Body}", eventType, Encoding.UTF8.GetString(body));
        return Results.Ok();
    });

    // Host page context the embed snippet needs - real values from config, not hardcoded in the HTML, so
    // README.md's setup step ("edit appsettings") is the only place these live.
    app.MapGet("/api/host-config", () => Results.Ok(new
    {
        apiBaseUrl = config["Platform:ApiBaseUrl"] ?? "",
        embedOrigin = config["Platform:EmbedOrigin"] ?? config["Platform:ApiBaseUrl"] ?? "",
        hostId = config["Platform:HostId"] ?? "",
        tenantId = config["Demo:TenantId"] ?? "demo-tenant",
        packageId = config["Demo:PackageId"] ?? "handofclient/hello-world",
        slotId = config["Demo:SlotId"] ?? "main-panel",
    }));

    // Serves sdk/embed-js's built drop-in script directly from source rather than requiring a copy step
    // into wwwroot - this is a monorepo sample, not a real deployment (a real host would npm-install
    // @handofclient/embed-js and serve/bundle dist/embed.global.js itself).
    app.MapGet("/embed.global.js", () =>
    {
        var path = Path.Combine(app.Environment.ContentRootPath, "..", "..", "..", "..", "sdk", "embed-js", "dist", "embed.global.js");
        return File.Exists(path)
            ? Results.File(path, "application/javascript")
            : Results.Problem(statusCode: 500, detail: "sdk/embed-js/dist/embed.global.js not found - run `npm run build` in sdk/embed-js first");
    });

    app.UseDefaultFiles();
    app.UseStaticFiles();

    app.MapGet("/healthz", () => Results.Ok(new { status = "ok" }));

    app.Run();
}
catch (Exception ex)
{
    logger.Error(ex, "Sample .NET host stopped because of an exception");
    throw;
}
finally
{
    LogManager.Shutdown();
}
