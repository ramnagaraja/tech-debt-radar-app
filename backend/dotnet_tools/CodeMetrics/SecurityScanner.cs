using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeMetrics;

/// Hand-rolled, semantic-model-based security checks — the C# counterpart to
/// what bandit does for Python via AST pattern matching, except these resolve
/// real symbols (via SemanticModel.GetSymbolInfo) rather than just matching
/// names, so e.g. a local class that happens to be named `SqlCommand` won't
/// false-positive. Severity/confidence weighting mirrors
/// python_analyzer.py's BANDIT_SEVERITY_WEIGHT / BANDIT_CONFIDENCE_WEIGHT
/// exactly so the two languages' security sub-scores are comparable.
public static class SecurityScanner
{
    private static readonly Dictionary<string, double> SeverityWeight = new() { ["LOW"] = 1.0, ["MEDIUM"] = 3.0, ["HIGH"] = 6.0 };
    private static readonly Dictionary<string, double> ConfidenceWeight = new() { ["LOW"] = 0.5, ["MEDIUM"] = 0.75, ["HIGH"] = 1.0 };

    private static readonly HashSet<string> SqlCommandTypes = new()
    {
        "System.Data.SqlClient.SqlCommand", "Microsoft.Data.SqlClient.SqlCommand",
        "System.Data.OleDb.OleDbCommand", "System.Data.Odbc.OdbcCommand",
    };

    private static readonly Dictionary<string, string> WeakCryptoTypes = new()
    {
        ["System.Security.Cryptography.MD5"] = "MEDIUM",
        ["System.Security.Cryptography.SHA1"] = "MEDIUM",
        ["System.Security.Cryptography.DES"] = "HIGH",
        ["System.Security.Cryptography.TripleDES"] = "HIGH",
        ["System.Security.Cryptography.RC2"] = "HIGH",
    };

    private static readonly string[] SecretNameHints =
        { "password", "passwd", "pwd", "secret", "apikey", "accesskey", "connectionstring", "token", "privatekey", "clientsecret" };
    private static readonly string[] ProtectedHints = { "hash", "encrypted", "digest", "salt" };

    public static void Scan(SyntaxNode root, SemanticModel model, FileMetrics into)
    {
        var issues = new List<SecurityIssueDto>();

        foreach (var node in root.DescendantNodes())
        {
            switch (node)
            {
                case ObjectCreationExpressionSyntax oce:
                    CheckSqlInjection(oce, model, issues);
                    CheckWeakCryptoConstructor(oce, model, issues);
                    break;
                case InvocationExpressionSyntax inv:
                    CheckWeakCryptoFactory(inv, model, issues);
                    CheckInsecureDeserialization(inv, model, issues);
                    CheckCommandInjection(inv, model, issues);
                    break;
                case VariableDeclaratorSyntax decl:
                    CheckHardcodedSecret(decl.Identifier.Text, decl.Initializer?.Value, decl, issues);
                    break;
                case PropertyDeclarationSyntax prop:
                    CheckHardcodedSecret(prop.Identifier.Text, prop.Initializer?.Value, prop, issues);
                    break;
            }
        }

        double weighted = 0.0;
        int highCount = 0;
        foreach (var issue in issues)
        {
            if (issue.Severity == "HIGH") highCount++;
            weighted += SeverityWeight.GetValueOrDefault(issue.Severity, 1.0) * ConfidenceWeight.GetValueOrDefault(issue.Confidence, 0.5);
        }

        into.SecurityIssueCount = issues.Count;
        into.SecurityHighCount = highCount;
        into.SecurityWeighted = Math.Round(weighted, 2);
        into.SecurityIssues = issues.Take(5).ToList();
    }

    private static int LineOf(SyntaxNode node) => node.GetLocation().GetLineSpan().StartLinePosition.Line + 1;

    private static void CheckSqlInjection(ObjectCreationExpressionSyntax oce, SemanticModel model, List<SecurityIssueDto> issues)
    {
        var symbol = model.GetSymbolInfo(oce).Symbol as IMethodSymbol;
        var typeName = symbol?.ContainingType?.ToDisplayString();
        if (typeName == null || !SqlCommandTypes.Contains(typeName)) return;

        var firstArg = oce.ArgumentList?.Arguments.FirstOrDefault()?.Expression;
        if (firstArg == null) return;

        bool unsafeBuild = firstArg is InterpolatedStringExpressionSyntax
            || (firstArg is BinaryExpressionSyntax bin && bin.IsKind(SyntaxKind.AddExpression));
        if (!unsafeBuild) return;

        issues.Add(new SecurityIssueDto
        {
            Severity = "HIGH",
            Confidence = "HIGH",
            TestId = "CS-SQLI",
            Text = $"{typeName} built from a concatenated/interpolated string - possible SQL injection.",
            Line = LineOf(oce),
        });
    }

    private static void CheckWeakCryptoConstructor(ObjectCreationExpressionSyntax oce, SemanticModel model, List<SecurityIssueDto> issues)
    {
        var symbol = model.GetSymbolInfo(oce).Symbol as IMethodSymbol;
        var typeName = symbol?.ContainingType?.ToDisplayString();
        if (typeName == null) return;
        var match = WeakCryptoTypes.Keys.FirstOrDefault(k => typeName.Contains(k.Split('.').Last()));
        if (match == null) return;
        issues.Add(new SecurityIssueDto
        {
            Severity = WeakCryptoTypes[match],
            Confidence = "HIGH",
            TestId = "CS-WEAK-CRYPTO",
            Text = $"Use of weak/broken cryptographic algorithm ({typeName}).",
            Line = LineOf(oce),
        });
    }

    private static void CheckWeakCryptoFactory(InvocationExpressionSyntax inv, SemanticModel model, List<SecurityIssueDto> issues)
    {
        if (inv.Expression is not MemberAccessExpressionSyntax { Name.Identifier.Text: "Create" }) return;
        var symbol = model.GetSymbolInfo(inv).Symbol as IMethodSymbol;
        var typeName = symbol?.ContainingType?.ToDisplayString();
        if (typeName == null || !WeakCryptoTypes.TryGetValue(typeName, out var severity)) return;
        issues.Add(new SecurityIssueDto
        {
            Severity = severity,
            Confidence = "HIGH",
            TestId = "CS-WEAK-CRYPTO",
            Text = $"Use of weak/broken cryptographic algorithm ({typeName}.Create()).",
            Line = LineOf(inv),
        });
    }

    private static void CheckInsecureDeserialization(InvocationExpressionSyntax inv, SemanticModel model, List<SecurityIssueDto> issues)
    {
        if (inv.Expression is not MemberAccessExpressionSyntax { Name.Identifier.Text: "Deserialize" }) return;
        var symbol = model.GetSymbolInfo(inv).Symbol as IMethodSymbol;
        var typeName = symbol?.ContainingType?.ToDisplayString();
        if (typeName is not ("System.Runtime.Serialization.Formatters.Binary.BinaryFormatter"
            or "System.Runtime.Serialization.Formatters.Soap.SoapFormatter")) return;
        issues.Add(new SecurityIssueDto
        {
            Severity = "HIGH",
            Confidence = "HIGH",
            TestId = "CS-INSECURE-DESERIALIZATION",
            Text = $"{typeName}.Deserialize on untrusted input can lead to remote code execution.",
            Line = LineOf(inv),
        });
    }

    private static void CheckCommandInjection(InvocationExpressionSyntax inv, SemanticModel model, List<SecurityIssueDto> issues)
    {
        if (inv.Expression is not MemberAccessExpressionSyntax { Name.Identifier.Text: "Start" }) return;
        var symbol = model.GetSymbolInfo(inv).Symbol as IMethodSymbol;
        if (symbol?.ContainingType?.ToDisplayString() != "System.Diagnostics.Process") return;
        var args = inv.ArgumentList.Arguments;
        if (args.Count == 0 || !args.Any(a => a.Expression is not LiteralExpressionSyntax)) return;
        issues.Add(new SecurityIssueDto
        {
            Severity = "HIGH",
            Confidence = "MEDIUM",
            TestId = "CS-COMMAND-INJECTION",
            Text = "Process.Start called with a non-literal argument - verify it isn't attacker-influenced.",
            Line = LineOf(inv),
        });
    }

    private static void CheckHardcodedSecret(string name, ExpressionSyntax? initializer, SyntaxNode node, List<SecurityIssueDto> issues)
    {
        if (initializer is not LiteralExpressionSyntax lit || !lit.IsKind(SyntaxKind.StringLiteralExpression)) return;
        if (string.IsNullOrWhiteSpace(lit.Token.ValueText)) return;
        var lower = name.ToLowerInvariant();
        if (ProtectedHints.Any(h => lower.Contains(h))) return;
        if (!SecretNameHints.Any(h => lower.Contains(h))) return;
        issues.Add(new SecurityIssueDto
        {
            Severity = "HIGH",
            Confidence = "MEDIUM",
            TestId = "CS-HARDCODED-SECRET",
            Text = $"'{name}' looks like a secret assigned a hardcoded string literal.",
            Line = LineOf(node),
        });
    }
}
