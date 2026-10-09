// Tiny CLI used to stand up the demo data the samples need: a registered host and an activated slot.
// It wraps PackageRegistry.RegisterHost (SuperAdminKey-gated) and Activate (HostApiKey-gated) for scripts
// and demos. It is deliberately not an admin UI.
using Google.Protobuf.WellKnownTypes;
using HandOfClient.Client;
using HandOfClient.V1;

if (args.Length == 0)
{
    PrintUsageAndExit(1);
    return;
}

var command = args[0];
var opts = ParseOptions(args[1..]);

switch (command)
{
    case "register-host":
        await RegisterHostAsync(opts);
        break;
    case "add-host-origins":
        await AddHostOriginsAsync(opts);
        break;
    case "rotate-api-key":
        await RotateApiKeyAsync(opts);
        break;
    case "activate":
        await ActivateAsync(opts);
        break;
    case "get-active-version":
        await GetActiveVersionAsync(opts);
        break;
    case "rollback":
        await RollbackAsync(opts);
        break;
    default:
        Console.Error.WriteLine($"Unknown command: {command}");
        PrintUsageAndExit(1);
        break;
}

static async Task RegisterHostAsync(Dictionary<string, string> opts)
{
    var apiBaseUrl = Require(opts, "api-base-url");
    var superAdminKey = Require(opts, "super-admin-key");
    var hostId = Require(opts, "host-id");
    var displayName = opts.GetValueOrDefault("display-name", hostId);
    var origins = opts.GetValueOrDefault("origins", "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    var webhookUrl = opts.GetValueOrDefault("webhook-url", "");

    using var admin = new HocClient(new HocClientOptions { BaseAddress = apiBaseUrl, ApiKey = superAdminKey });
    var request = new RegisterHostRequest { Host = new Host { HostId = hostId, DisplayName = displayName, WebhookUrl = webhookUrl } };
    request.Host.RegisteredOrigins.AddRange(origins);

    var response = await admin.PackageRegistry.RegisterHostAsync(request);

    Console.WriteLine($"Registered host '{response.Host.HostId}'.");
    Console.WriteLine();
    Console.WriteLine("Paste these into the consuming host's user-secrets (never commit them):");
    Console.WriteLine($"  dotnet user-secrets set Platform:HostId \"{response.Host.HostId}\"");
    Console.WriteLine($"  dotnet user-secrets set Platform:HostApiKey \"{response.ApiKey}\"");
    if (!string.IsNullOrEmpty(response.WebhookSecret))
        Console.WriteLine($"  dotnet user-secrets set Platform:WebhookSecret \"{response.WebhookSecret}\"");
    Console.WriteLine();
    Console.WriteLine("These are returned exactly once and never retrievable again from the platform.");
}

static async Task AddHostOriginsAsync(Dictionary<string, string> opts)
{
    var apiBaseUrl = Require(opts, "api-base-url");
    var superAdminKey = Require(opts, "super-admin-key");
    var hostId = Require(opts, "host-id");
    var origins = Require(opts, "origins").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    using var admin = new HocClient(new HocClientOptions { BaseAddress = apiBaseUrl, ApiKey = superAdminKey });
    var request = new AddHostOriginsRequest { HostId = hostId };
    request.Origins.AddRange(origins);

    var response = await admin.PackageRegistry.AddHostOriginsAsync(request);

    Console.WriteLine($"Host '{response.Host.HostId}' registered origins are now:");
    foreach (var origin in response.Host.RegisteredOrigins)
        Console.WriteLine($"  {origin}");
}

static async Task RotateApiKeyAsync(Dictionary<string, string> opts)
{
    var apiBaseUrl = Require(opts, "api-base-url");
    var superAdminKey = Require(opts, "super-admin-key");
    var hostId = Require(opts, "host-id");

    using var admin = new HocClient(new HocClientOptions { BaseAddress = apiBaseUrl, ApiKey = superAdminKey });
    var response = await admin.PackageRegistry.RotateApiKeyAsync(new RotateApiKeyRequest { HostId = hostId });

    Console.WriteLine($"Rotated API key for host '{response.Host.HostId}'.");
    Console.WriteLine("The old key stopped working immediately. New key (shown once, never retrievable again):");
    Console.WriteLine($"  {response.ApiKey}");
    Console.WriteLine();
    Console.WriteLine("Update every place the old key was configured before anything tries to use it again.");
}

static async Task ActivateAsync(Dictionary<string, string> opts)
{
    var apiBaseUrl = Require(opts, "api-base-url");
    var hostApiKey = Require(opts, "host-api-key");
    var hostId = Require(opts, "host-id");
    var tenantId = Require(opts, "tenant-id");
    var packageId = Require(opts, "package-id");
    var slotId = Require(opts, "slot-id");
    var version = Require(opts, "version");

    using var client = new HocClient(new HocClientOptions { BaseAddress = apiBaseUrl, ApiKey = hostApiKey });
    var response = await client.PackageRegistry.ActivateAsync(new ActivateRequest
    {
        Scope = new TenantScope { HostId = hostId, TenantId = tenantId, PackageId = packageId },
        SlotId = slotId,
        Version = version,
    });

    Console.WriteLine($"Activated {packageId}@{version} for tenant '{tenantId}' slot '{slotId}'.");
    Console.WriteLine($"Enabled: {response.Activation.Enabled}, activated at: {response.Activation.ActivatedAt}");
}

static async Task GetActiveVersionAsync(Dictionary<string, string> opts)
{
    // GetActiveVersion is a Public RPC (AuthPolicy.Methods) - no credential is strictly required, but
    // --host-api-key is accepted anyway for command-line consistency with the other commands here.
    var apiBaseUrl = Require(opts, "api-base-url");
    var hostId = Require(opts, "host-id");
    var tenantId = Require(opts, "tenant-id");
    var packageId = Require(opts, "package-id");
    var slotId = Require(opts, "slot-id");
    var apiKey = opts.GetValueOrDefault("host-api-key", "");

    using var client = new HocClient(new HocClientOptions { BaseAddress = apiBaseUrl, ApiKey = apiKey });
    var response = await client.PackageRegistry.GetActiveVersionAsync(new GetActiveVersionRequest
    {
        Scope = new TenantScope { HostId = hostId, TenantId = tenantId, PackageId = packageId },
        SlotId = slotId,
    });

    Console.WriteLine($"Active version for {packageId}/{slotId} (tenant '{tenantId}'): {response.Version.Version}");
    Console.WriteLine($"Enabled: {response.Enabled}, published at: {response.Version.PublishedAt}, published by: {response.Version.PublishedBy}");
}

static async Task RollbackAsync(Dictionary<string, string> opts)
{
    // Safety-net counterpart to ActivateAsync: automation can call this if a production Activate's
    // post-activation verification doesn't confirm the expected version live. target-version MUST be a version this tenant was
    // previously activated on (RollbackRequest's own contract); the platform enforces this, this CLI does
    // not re-validate it client-side.
    var apiBaseUrl = Require(opts, "api-base-url");
    var hostApiKey = Require(opts, "host-api-key");
    var hostId = Require(opts, "host-id");
    var tenantId = Require(opts, "tenant-id");
    var packageId = Require(opts, "package-id");
    var slotId = Require(opts, "slot-id");
    var targetVersion = Require(opts, "target-version");

    using var client = new HocClient(new HocClientOptions { BaseAddress = apiBaseUrl, ApiKey = hostApiKey });
    var response = await client.PackageRegistry.RollbackAsync(new RollbackRequest
    {
        Scope = new TenantScope { HostId = hostId, TenantId = tenantId, PackageId = packageId },
        SlotId = slotId,
        TargetVersion = targetVersion,
    });

    Console.WriteLine($"Rolled back {packageId}/{slotId} (tenant '{tenantId}') to version {targetVersion}.");
    Console.WriteLine($"Enabled: {response.Activation.Enabled}, activated at: {response.Activation.ActivatedAt}");
}

static string Require(Dictionary<string, string> opts, string key) =>
    opts.TryGetValue(key, out var value) ? value : throw new ArgumentException($"--{key} is required");

static Dictionary<string, string> ParseOptions(string[] args)
{
    var result = new Dictionary<string, string>();
    for (var i = 0; i < args.Length; i++)
    {
        if (!args[i].StartsWith("--", StringComparison.Ordinal)) continue;
        var key = args[i][2..];
        var value = i + 1 < args.Length ? args[++i] : "";
        result[key] = value;
    }
    return result;
}

static void PrintUsageAndExit(int code)
{
    Console.Error.WriteLine(
        """
        Usage:
          dotnet run -- register-host --api-base-url <url> --super-admin-key <key> --host-id <id>
                                       [--display-name <name>] [--origins <origin1,origin2>] [--webhook-url <url>]

          dotnet run -- add-host-origins --api-base-url <url> --super-admin-key <key> --host-id <id>
                                          --origins <origin1,origin2>

          dotnet run -- rotate-api-key --api-base-url <url> --super-admin-key <key> --host-id <id>

          dotnet run -- activate --api-base-url <url> --host-api-key <key> --host-id <id>
                                  --tenant-id <id> --package-id <id> --slot-id <id> --version <semver>

          dotnet run -- get-active-version --api-base-url <url> --host-id <id> --tenant-id <id>
                                            --package-id <id> --slot-id <id> [--host-api-key <key>]

          dotnet run -- rollback --api-base-url <url> --host-api-key <key> --host-id <id>
                                  --tenant-id <id> --package-id <id> --slot-id <id> --target-version <semver>
        """);
    Environment.Exit(code);
}
