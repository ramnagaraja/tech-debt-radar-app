using CodeMetrics;
using Microsoft.Build.Locator;

if (args.Length < 2)
{
    Console.Error.WriteLine("Usage: CodeMetrics <repoPath> <outputJsonPath>");
    return 1;
}

var repoPath = Path.GetFullPath(args[0]);
var outputPath = Path.GetFullPath(args[1]);

// Must happen before any Microsoft.Build.* / Microsoft.CodeAnalysis.MSBuild type
// is touched — that all lives inside Runner.RunAsync, which the JIT hasn't
// compiled yet at this point, so this ordering is safe.
if (!MSBuildLocator.IsRegistered)
{
    // On a machine that also has Visual Studio / Build Tools installed,
    // RegisterDefaults() can pick that (classic .NET Framework) MSBuild
    // instead of the .NET SDK's own — the two are binary-incompatible with
    // this tool (a .NET 8 exe), producing a TypeLoadException deep inside
    // MSBuild rather than a clear error. Prefer the SDK-resolved instance
    // explicitly when more than one is available.
    var instances = MSBuildLocator.QueryVisualStudioInstances().ToList();
    var sdkInstance = instances.FirstOrDefault(i => i.DiscoveryType == DiscoveryType.DotNetSdk)
        ?? instances.OrderByDescending(i => i.Version).FirstOrDefault();
    if (sdkInstance != null)
        MSBuildLocator.RegisterInstance(sdkInstance);
    else
        MSBuildLocator.RegisterDefaults();
}

return await Runner.RunAsync(repoPath, outputPath);
