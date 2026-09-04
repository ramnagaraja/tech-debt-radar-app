using System.Text.Json.Serialization;

namespace CodeMetrics;

/// JSON contract consumed by backend/code_analyzers/dotnet_analyzer.py.
/// Field names/shape mirror what python_analyzer.py computes per file so
/// both languages plug into the same scoring.compute_debt_scores().
public class SecurityIssueDto
{
    [JsonPropertyName("severity")] public string Severity { get; set; } = "";
    [JsonPropertyName("confidence")] public string Confidence { get; set; } = "";
    [JsonPropertyName("test_id")] public string TestId { get; set; } = "";
    [JsonPropertyName("text")] public string Text { get; set; } = "";
    [JsonPropertyName("line")] public int Line { get; set; }
}

public class FileMetrics
{
    [JsonPropertyName("loc")] public int Loc { get; set; }
    [JsonPropertyName("sloc")] public int Sloc { get; set; }
    [JsonPropertyName("avg_complexity")] public double AvgComplexity { get; set; }
    [JsonPropertyName("max_complexity")] public int MaxComplexity { get; set; }
    [JsonPropertyName("maintainability_index")] public double MaintainabilityIndex { get; set; } = 100;
    [JsonPropertyName("function_count")] public int FunctionCount { get; set; }
    [JsonPropertyName("security_issue_count")] public int SecurityIssueCount { get; set; }
    [JsonPropertyName("security_high_count")] public int SecurityHighCount { get; set; }
    [JsonPropertyName("security_weighted")] public double SecurityWeighted { get; set; }
    [JsonPropertyName("security_issues")] public List<SecurityIssueDto> SecurityIssues { get; set; } = new();
    [JsonPropertyName("long_function_count")] public int LongFunctionCount { get; set; }
    [JsonPropertyName("max_nesting_depth")] public int MaxNestingDepth { get; set; }
    [JsonPropertyName("many_params_count")] public int ManyParamsCount { get; set; }
    [JsonPropertyName("god_file")] public bool GodFile { get; set; }
    [JsonPropertyName("function_hashes")] public List<string> FunctionHashes { get; set; } = new();
    [JsonPropertyName("public_function_count")] public int PublicFunctionCount { get; set; }
    [JsonPropertyName("long_conditional_chain_count")] public int LongConditionalChainCount { get; set; }
}

public class EdgeDto
{
    [JsonPropertyName("source")] public string Source { get; set; } = "";
    [JsonPropertyName("target")] public string Target { get; set; } = "";
    [JsonPropertyName("edge_type")] public string EdgeType { get; set; } = "code_import";
}

public class AnalysisOutput
{
    [JsonPropertyName("files")] public Dictionary<string, FileMetrics> Files { get; set; } = new();
    [JsonPropertyName("edges")] public List<EdgeDto> Edges { get; set; } = new();
}

public static class JsonOptions
{
    public static readonly System.Text.Json.JsonSerializerOptions Default = new() { WriteIndented = false };
}
