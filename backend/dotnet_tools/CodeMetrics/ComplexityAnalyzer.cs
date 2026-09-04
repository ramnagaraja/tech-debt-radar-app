using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CodeMetrics;

/// C# equivalent of python_analyzer.py's compute_complexity + compute_design_smells,
/// using real Roslyn syntax instead of Python's ast/radon so both languages produce
/// comparable numbers (same maintainability-index formula, same design-smell
/// thresholds: long function >50 lines, deep nesting >4, many params >5, god file >500 loc).
public static class ComplexityAnalyzer
{
    private static readonly Type[] NestingNodeTypes =
    {
        typeof(IfStatementSyntax), typeof(ForStatementSyntax), typeof(ForEachStatementSyntax),
        typeof(WhileStatementSyntax), typeof(DoStatementSyntax), typeof(TryStatementSyntax),
        typeof(UsingStatementSyntax), typeof(LockStatementSyntax), typeof(SwitchStatementSyntax),
    };

    public static FileMetrics Analyze(SyntaxTree tree, SyntaxNode root)
    {
        var text = tree.GetText();
        int loc = text.Lines.Count;

        // A line "counts" toward sloc if it contains at least one real token —
        // this naturally excludes blank lines and comment-only lines (comments
        // are trivia, not tokens) without needing a separate comment-stripping pass.
        var codeLines = new HashSet<int>();
        foreach (var token in root.DescendantTokens())
            codeLines.Add(tree.GetLineSpan(token.Span).StartLinePosition.Line);
        int sloc = codeLines.Count;

        var functionNodes = root.DescendantNodes()
            .Where(n => n is MethodDeclarationSyntax or ConstructorDeclarationSyntax or LocalFunctionStatementSyntax)
            .ToList();

        var complexities = new List<int>();
        int longFunctions = 0, manyParams = 0, maxNesting = 0;

        foreach (var fn in functionNodes)
        {
            var body = GetBody(fn) ?? fn;
            int cc = ComputeCyclomaticComplexity(body);
            complexities.Add(cc);

            var lineSpan = tree.GetLineSpan(fn.Span);
            int lines = lineSpan.EndLinePosition.Line - lineSpan.StartLinePosition.Line + 1;
            if (lines > 50) longFunctions++;

            if (GetParameterCount(fn) > 5) manyParams++;

            maxNesting = Math.Max(maxNesting, MaxNestingDepth(fn, 0));
        }

        double avgComplexity = complexities.Count > 0 ? complexities.Average() : 0.0;
        int maxComplexity = complexities.Count > 0 ? complexities.Max() : 0;

        double mi = ComputeMaintainabilityIndex(root, avgComplexity > 0 ? avgComplexity : 1.0, loc);

        return new FileMetrics
        {
            Loc = loc,
            Sloc = sloc,
            AvgComplexity = Math.Round(avgComplexity, 2),
            MaxComplexity = maxComplexity,
            MaintainabilityIndex = Math.Round(mi, 2),
            FunctionCount = functionNodes.Count,
            LongFunctionCount = longFunctions,
            MaxNestingDepth = maxNesting,
            ManyParamsCount = manyParams,
            GodFile = loc > 500,
        };
    }

    private static SyntaxNode? GetBody(SyntaxNode fn) => fn switch
    {
        MethodDeclarationSyntax m => (SyntaxNode?)m.Body ?? m.ExpressionBody,
        ConstructorDeclarationSyntax c => (SyntaxNode?)c.Body ?? c.ExpressionBody,
        LocalFunctionStatementSyntax l => (SyntaxNode?)l.Body ?? l.ExpressionBody,
        _ => null,
    };

    private static int GetParameterCount(SyntaxNode fn)
    {
        var parameters = fn switch
        {
            MethodDeclarationSyntax m => m.ParameterList.Parameters,
            ConstructorDeclarationSyntax c => c.ParameterList.Parameters,
            LocalFunctionStatementSyntax l => l.ParameterList.Parameters,
            _ => default,
        };
        if (parameters.Count == 0) return 0;
        // Extension methods' leading `this` parameter is implicit at call sites —
        // exclude it for parity with Python excluding self/cls.
        return parameters.Any(p => p.Modifiers.Any(SyntaxKind.ThisKeyword)) ? parameters.Count - 1 : parameters.Count;
    }

    private static int ComputeCyclomaticComplexity(SyntaxNode body)
    {
        int complexity = 1;
        foreach (var node in body.DescendantNodesAndSelf())
        {
            switch (node)
            {
                case IfStatementSyntax:
                case ForStatementSyntax:
                case ForEachStatementSyntax:
                case ForEachVariableStatementSyntax:
                case WhileStatementSyntax:
                case DoStatementSyntax:
                case CaseSwitchLabelSyntax:
                case CasePatternSwitchLabelSyntax:
                case SwitchExpressionArmSyntax:
                case CatchClauseSyntax:
                case ConditionalExpressionSyntax:
                    complexity++;
                    break;
                case BinaryExpressionSyntax bin when bin.IsKind(SyntaxKind.LogicalAndExpression) || bin.IsKind(SyntaxKind.LogicalOrExpression):
                    complexity++;
                    break;
            }
        }
        return complexity;
    }

    private static int MaxNestingDepth(SyntaxNode node, int depth)
    {
        int max = depth;
        foreach (var child in node.ChildNodes())
        {
            bool isNesting = NestingNodeTypes.Contains(child.GetType());
            int nextDepth = isNesting ? depth + 1 : depth;
            max = Math.Max(max, MaxNestingDepth(child, nextDepth));
        }
        return max;
    }

    /// Classic Halstead-based maintainability index (same formula radon uses for
    /// Python): MI = max(0, (171 - 5.2*ln(V) - 0.23*CC - 16.2*ln(LOC)) * 100/171).
    /// Halstead volume V is computed for real from this file's own token stream
    /// (distinct/total operators vs operands) rather than approximated.
    private static double ComputeMaintainabilityIndex(SyntaxNode root, double avgComplexity, int loc)
    {
        var operators = new Dictionary<string, int>();
        var operands = new Dictionary<string, int>();

        foreach (var token in root.DescendantTokens())
        {
            var kind = token.Kind();
            bool isOperand = kind == SyntaxKind.IdentifierToken
                || kind == SyntaxKind.NumericLiteralToken
                || kind == SyntaxKind.StringLiteralToken
                || kind == SyntaxKind.CharacterLiteralToken
                || kind == SyntaxKind.TrueKeyword
                || kind == SyntaxKind.FalseKeyword
                || kind == SyntaxKind.NullKeyword;
            var bucket = isOperand ? operands : operators;
            var key = token.Text;
            bucket[key] = bucket.GetValueOrDefault(key) + 1;
        }

        int n1 = operators.Count, n2 = operands.Count;
        long bigN1 = operators.Values.Sum(v => (long)v), bigN2 = operands.Values.Sum(v => (long)v);
        double vocabulary = n1 + n2;
        double length = bigN1 + bigN2;
        double halsteadVolume = vocabulary > 0 ? length * Math.Log2(vocabulary) : 0.0;

        double safeLoc = Math.Max(loc, 1);
        double safeVolume = Math.Max(halsteadVolume, 1.0);
        double mi = 171 - 5.2 * Math.Log(safeVolume) - 0.23 * avgComplexity - 16.2 * Math.Log(safeLoc);
        mi = Math.Max(0.0, mi * 100.0 / 171.0);
        return Math.Min(100.0, mi);
    }
}
