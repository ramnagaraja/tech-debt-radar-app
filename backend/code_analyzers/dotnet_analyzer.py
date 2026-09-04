"""
.NET code-side analysis. Unlike the Python path (which does everything with
Python-native libraries), the actual metric/security/dependency-graph work
here is done by a small bundled Roslyn tool
(dotnet_tools/CodeMetrics, a C# console app using Microsoft.CodeAnalysis)
because getting real cyclomatic complexity, a real semantic dependency
graph, and real static security findings for C# requires the Roslyn
compiler APIs — there's no equivalent to radon/bandit/ast in the Python
ecosystem for C#.

This module just shells out to that tool, reads its JSON output, fills in
git churn (language-agnostic, reused from scoring.py), and hands everything
to scoring.compute_debt_scores so .NET files score exactly the way Python
files do.
"""
import json
import os
import subprocess
import tempfile
from pathlib import Path

from . import scoring

BACKEND_DIR = Path(__file__).resolve().parent.parent
TOOL_DIR = BACKEND_DIR / "dotnet_tools" / "CodeMetrics"

EXCLUDE_DIRS = {".git", "bin", "obj", "node_modules", "packages", ".vs"}

DEFAULT_FILE_METRICS = {
    "loc": 0, "sloc": 0, "avg_complexity": 0, "max_complexity": 0, "maintainability_index": 100,
    "function_count": 0, "security_issue_count": 0, "security_high_count": 0,
    "security_weighted": 0, "security_issues": [], "long_function_count": 0,
    "max_nesting_depth": 0, "many_params_count": 0, "god_file": False,
    "function_hashes": [], "public_function_count": 0, "long_conditional_chain_count": 0,
}


class DotnetToolError(RuntimeError):
    pass


def find_cs_files(repo_path):
    files = []
    for root, dirs, fnames in os.walk(repo_path):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for f in fnames:
            if f.endswith(".cs"):
                full = os.path.join(root, f)
                rel = os.path.relpath(full, repo_path).replace(os.sep, "/")
                files.append((full, rel))
    return files


def run_roslyn_tool(repo_path, timeout=600):
    """Runs the bundled CodeMetrics console tool against repo_path. Returns
    the parsed JSON {"files": {rel: {...}}, "edges": [...]}."""
    if not TOOL_DIR.exists():
        raise DotnetToolError(f"Roslyn helper tool not found at {TOOL_DIR}")

    with tempfile.TemporaryDirectory() as tmp:
        out_path = os.path.join(tmp, "metrics.json")
        try:
            proc = subprocess.run(
                ["dotnet", "run", "--project", str(TOOL_DIR), "--",
                 os.path.abspath(repo_path), out_path],
                capture_output=True, text=True, timeout=timeout,
            )
        except FileNotFoundError:
            raise DotnetToolError(
                "The .NET SDK ('dotnet' on PATH) is required to analyze .NET codebases but wasn't found."
            )
        except subprocess.TimeoutExpired:
            raise DotnetToolError(f"CodeMetrics tool timed out after {timeout}s.")

        if proc.returncode != 0 or not os.path.exists(out_path):
            # Exit codes 2 and 3 are Runner.cs's own diagnosed failures (no
            # project loadable / legacy non-SDK-style project detected) — it
            # prints one clear, actionable line to stderr for these. Surface
            # just that rather than the noisy MSBuild/BuildHost exception
            # trace that can precede it. Any other exit code is unexpected,
            # so keep the full dump there for debugging.
            if proc.returncode in (2, 3):
                lines = [l for l in proc.stderr.splitlines() if l.strip()]
                raise DotnetToolError(lines[-1] if lines else f"CodeMetrics tool failed (exit {proc.returncode}).")
            raise DotnetToolError(
                f"CodeMetrics tool failed (exit {proc.returncode}).\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
            )
        with open(out_path, "r", encoding="utf-8") as fh:
            return json.load(fh)


def collect_metrics(repo_path):
    """Returns {'metrics': {rel: {...}}, 'edges': [...], 'source_text': {...}}
    — everything analyze_codebase() computes, but *before* scoring. See
    python_analyzer.collect_metrics for why this split exists."""
    files = find_cs_files(repo_path)
    rel_files = [rel for _, rel in files]

    source_text = {}
    for full, rel in files:
        try:
            with open(full, "r", encoding="utf-8", errors="ignore") as fh:
                source_text[rel] = fh.read()
        except Exception:
            source_text[rel] = ""

    tool_output = run_roslyn_tool(repo_path)
    tool_files = tool_output.get("files", {})
    edges = tool_output.get("edges", [])

    churn = scoring.compute_churn(repo_path, rel_files)

    metrics = {}
    for rel in rel_files:
        raw = tool_files.get(rel, {})
        m = {key: raw.get(key, default) for key, default in DEFAULT_FILE_METRICS.items()}
        m["churn"] = churn.get(rel, 0)
        metrics[rel] = m

    return {"metrics": metrics, "edges": edges, "source_text": source_text}


def analyze_codebase(repo_path):
    """Returns {'files': [...], 'edges': [...], '_source_text': {rel: src}}
    — same contract as python_analyzer.analyze_codebase."""
    collected = collect_metrics(repo_path)
    rows = scoring.compute_debt_scores(collected["metrics"], collected["edges"])
    return {"files": rows, "edges": collected["edges"], "_source_text": collected["source_text"]}
