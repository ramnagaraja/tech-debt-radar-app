using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.MSBuild;

namespace CodeMetrics;

public static class Runner
{
    private static readonly string[] ExcludeDirNames = { ".git", "bin", "obj", "node_modules", "packages", ".vs" };

    public static async Task<int> RunAsync(string repoPath, string outputPath)
    {
        using var workspace = MSBuildWorkspace.Create();
        workspace.WorkspaceFailed += (_, e) => Console.Error.WriteLine($"[workspace] {e.Diagnostic.Message}");

        var projects = new List<Project>();

        var slnFiles = Directory.EnumerateFiles(repoPath, "*.sln", SearchOption.AllDirectories)
            .Where(p => !IsExcluded(repoPath, p)).ToList();

        if (slnFiles.Count > 0)
        {
            foreach (var sln in slnFiles)
            {
                try
                {
                    var solution = await workspace.OpenSolutionAsync(sln);
                    projects.AddRange(solution.Projects);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"[sln:{sln}] failed to open: {ex.Message}");
                }
            }
        }
        else
        {
            var csprojFiles = Directory.EnumerateFiles(repoPath, "*.csproj", SearchOption.AllDirectories)
                .Where(p => !IsExcluded(repoPath, p)).ToList();
            foreach (var csproj in csprojFiles)
            {
                try
                {
                    var project = await workspace.OpenProjectAsync(csproj);
                    projects.Add(project);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"[csproj:{csproj}] failed to open: {ex.Message}");
                }
            }
        }

        // Multi-targeted / solution-referenced-from-multiple-places projects can
        // surface more than once — keep just the first instance of each.
        projects = projects.Where(p => p.FilePath != null)
            .GroupBy(p => p.FilePath!)
            .Select(g => g.First())
            .ToList();

        if (projects.Count == 0)
        {
            var allCsproj = Directory.EnumerateFiles(repoPath, "*.csproj", SearchOption.AllDirectories)
                .Where(p => !IsExcluded(repoPath, p)).ToList();
            var legacyCsproj = allCsproj.Where(LooksLikeLegacyProject).ToList();
            if (legacyCsproj.Count > 0)
            {
                Console.Error.WriteLine(
                    $"Found {legacyCsproj.Count} legacy (non-SDK-style) project file(s), e.g. '{Path.GetFileName(legacyCsproj[0])}'. " +
                    "This looks like a classic .NET Framework project (old <Project ToolsVersion=...> format, " +
                    "TargetFrameworkVersion, packages.config) rather than a modern SDK-style .NET project. " +
                    "This analyzer supports modern SDK-style .NET (.NET Core / .NET 5 and later, <Project Sdk=\"...\">) " +
                    "only — classic full-.NET-Framework / old-style ASP.NET projects need a full Visual Studio " +
                    "MSBuild install to evaluate and aren't supported here.");
                return 3;
            }
            Console.Error.WriteLine(
                "No .NET project could be loaded (no .sln/.csproj found, or all failed to open - see above). " +
                "Ensure `dotnet restore` succeeds against this repository first.");
            return 2;
        }

        var repoPrefix = repoPath.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar) + Path.DirectorySeparatorChar;
        var pathToRel = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var compilations = new List<Compilation>();

        foreach (var project in projects)
        {
            var compilation = await project.GetCompilationAsync();
            if (compilation == null) continue;
            compilations.Add(compilation);
            foreach (var tree in compilation.SyntaxTrees)
            {
                if (string.IsNullOrEmpty(tree.FilePath)) continue;
                var full = Path.GetFullPath(tree.FilePath);
                if (!full.StartsWith(repoPrefix, StringComparison.OrdinalIgnoreCase)) continue;
                // MSBuild-generated sources (obj/**/*.g.cs, AssemblyInfo.cs, ...) are
                // part of the real compilation but aren't code the user wrote —
                // skip them so they don't clutter the heatmap or dependency graph.
                if (IsExcluded(repoPath, full)) continue;
                pathToRel[full] = ToRel(repoPath, full);
            }
        }

        var fileMetrics = new Dictionary<string, FileMetrics>();
        var edges = new HashSet<(string Source, string Target)>();

        foreach (var compilation in compilations)
        {
            foreach (var tree in compilation.SyntaxTrees)
            {
                if (string.IsNullOrEmpty(tree.FilePath)) continue;
                var full = Path.GetFullPath(tree.FilePath);
                if (!pathToRel.TryGetValue(full, out var rel)) continue;
                if (fileMetrics.ContainsKey(rel)) continue; // already processed via another project instance

                var root = await tree.GetRootAsync();
                var semanticModel = compilation.GetSemanticModel(tree);

                var metrics = ComplexityAnalyzer.Analyze(tree, root);
                SecurityScanner.Scan(root, semanticModel, metrics);
                fileMetrics[rel] = metrics;

                foreach (var target in DependencyGraphBuilder.FindDependencies(root, semanticModel, pathToRel, full))
                {
                    if (target != rel) edges.Add((rel, target));
                }
            }
        }

        var output = new AnalysisOutput
        {
            Files = fileMetrics,
            Edges = edges.Select(e => new EdgeDto { Source = e.Source, Target = e.Target }).ToList(),
        };

        await File.WriteAllTextAsync(outputPath, JsonSerializer.Serialize(output, JsonOptions.Default));
        return 0;
    }

    // SDK-style projects declare Sdk= on the root Project element and use
    // TargetFramework/TargetFrameworks; classic (pre-2017-ish) .NET Framework
    // projects use TargetFrameworkVersion and never declare Sdk=.
    private static bool LooksLikeLegacyProject(string csprojPath)
    {
        try
        {
            var text = File.ReadAllText(csprojPath);
            if (text.Contains("<TargetFrameworkVersion", StringComparison.OrdinalIgnoreCase)) return true;
            var projectTagStart = text.IndexOf("<Project", StringComparison.OrdinalIgnoreCase);
            if (projectTagStart < 0) return false;
            var projectTagEnd = text.IndexOf('>', projectTagStart);
            if (projectTagEnd < 0) return false;
            var openTag = text.Substring(projectTagStart, projectTagEnd - projectTagStart);
            return !openTag.Contains("Sdk=", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static bool IsExcluded(string repoPath, string filePath)
    {
        var rel = Path.GetRelativePath(repoPath, filePath);
        return rel.Split(Path.DirectorySeparatorChar).Any(part => ExcludeDirNames.Contains(part, StringComparer.OrdinalIgnoreCase));
    }

    private static string ToRel(string repoPath, string fullPath) =>
        Path.GetRelativePath(repoPath, fullPath).Replace(Path.DirectorySeparatorChar, '/');
}
