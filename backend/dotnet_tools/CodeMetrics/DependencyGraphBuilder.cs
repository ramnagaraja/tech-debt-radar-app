using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeMetrics;

/// Real semantic dependency edges: resolves each name/type reference to its
/// declaring symbol via the semantic model and maps that back to the file it's
/// declared in. This is accurate where the Python path can only do string-based
/// module-name matching (see python_analyzer.py's build_import_graph) — a
/// reference to `Foo` here only becomes an edge if Roslyn can prove `Foo`
/// resolves to a symbol actually declared inside this repo.
public static class DependencyGraphBuilder
{
    public static IEnumerable<string> FindDependencies(
        SyntaxNode root, SemanticModel model, IReadOnlyDictionary<string, string> pathToRel, string currentFullPath)
    {
        var targets = new HashSet<string>();

        foreach (var node in root.DescendantNodes())
        {
            ExpressionSyntax? exprToResolve = node switch
            {
                SimpleBaseTypeSyntax baseType => baseType.Type,
                IdentifierNameSyntax or GenericNameSyntax => (ExpressionSyntax)node,
                _ => null,
            };
            if (exprToResolve == null) continue;

            var info = model.GetSymbolInfo(exprToResolve);
            var symbol = info.Symbol ?? info.CandidateSymbols.FirstOrDefault();
            if (symbol == null) continue;
            // Namespace symbols (including the global namespace, which every
            // `global::X` qualifier — e.g. compiler-generated GlobalUsings.g.cs —
            // resolves through) merge DeclaringSyntaxReferences across every file
            // that contributes to that namespace, which would otherwise fan out
            // into a spurious edge to nearly every other file in the project.
            // We only want real type/member dependencies here.
            if (symbol is INamespaceSymbol) continue;

            foreach (var reference in symbol.OriginalDefinition.DeclaringSyntaxReferences)
            {
                if (string.IsNullOrEmpty(reference.SyntaxTree.FilePath)) continue;
                var declFullPath = Path.GetFullPath(reference.SyntaxTree.FilePath);
                if (declFullPath.Equals(currentFullPath, StringComparison.OrdinalIgnoreCase)) continue;
                if (pathToRel.TryGetValue(declFullPath, out var rel))
                    targets.Add(rel);
            }
        }

        return targets;
    }
}
