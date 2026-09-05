"""
TypeScript (React/Angular/generic) code-side analysis. Like the .NET path,
this shells out to a small bundled tool — backend/ts_tools/CodeMetrics, a
Node.js script using the real TypeScript compiler (`typescript` npm
package) — rather than reimplementing a TS parser in Python. Unlike the
.NET path there's no project-wide MSBuild-style resolution step: every
check here (complexity, design smells, the doc-grounded checks, and the
dependency graph) is purely syntactic per file, so there's no equivalent
failure mode to a legacy/unloadable project — a file that fails to parse is
just skipped, logged, and the rest of the run continues.

Node.js is already a hard requirement for this app's own frontend dev
workflow, so — unlike the .NET SDK — there's no new "is this installed on
the host" question. The bundled tool's own npm dependency (`typescript`)
is installed once, automatically, the first time it's used.
"""
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from . import scoring

BACKEND_DIR = Path(__file__).resolve().parent.parent
TOOL_DIR = BACKEND_DIR / "ts_tools" / "CodeMetrics"

EXCLUDE_DIRS = {
    ".git", "node_modules", "dist", "build", "out", ".angular", "coverage",
    ".next", ".nuxt", ".cache", ".vscode", ".vs",
}

DEFAULT_FILE_METRICS = {
    "loc": 0, "sloc": 0, "avg_complexity": 0, "max_complexity": 0, "maintainability_index": 100,
    "function_count": 0, "security_issue_count": 0, "security_high_count": 0,
    "security_weighted": 0, "security_issues": [], "long_function_count": 0,
    "max_nesting_depth": 0, "many_params_count": 0, "god_file": False,
    "function_hashes": [], "public_function_count": 0, "long_conditional_chain_count": 0,
    "any_usage_count": 0, "non_strict_typescript": False, "static_utility_class_count": 0,
    "many_boolean_props_count": 0,
}


class TsToolError(RuntimeError):
    pass


def find_ts_files(repo_path):
    files = []
    for root, dirs, fnames in os.walk(repo_path):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for f in fnames:
            if f.endswith((".ts", ".tsx", ".js", ".jsx")) and not f.endswith(".d.ts"):
                full = os.path.join(root, f)
                rel = os.path.relpath(full, repo_path).replace(os.sep, "/")
                files.append((full, rel))
    return files


def _ensure_tool_deps(timeout=300):
    """Installs the bundled tool's own npm dependency (`typescript`) the
    first time it's needed — mirrors how `dotnet run` transparently restores
    NuGet packages on first use."""
    if (TOOL_DIR / "node_modules").exists():
        return
    # On Windows, "npm" resolves to npm.cmd — a shell shim subprocess.run()
    # can't exec directly without shell=True. shutil.which() applies
    # PATHEXT resolution the same way a shell's own lookup would, and hands
    # back a real, directly executable path on every OS.
    npm = shutil.which("npm")
    if not npm:
        raise TsToolError("Node.js/npm ('npm' on PATH) is required to analyze TypeScript codebases but wasn't found.")
    try:
        proc = subprocess.run(
            [npm, "install", "--no-audit", "--no-fund"],
            cwd=str(TOOL_DIR), capture_output=True, text=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        raise TsToolError(f"Installing the TypeScript analyzer's own dependencies timed out after {timeout}s.")
    if proc.returncode != 0:
        raise TsToolError(f"Failed to install the TypeScript analyzer's dependencies.\n{proc.stderr}")


def run_ts_tool(repo_path, timeout=600):
    """Runs the bundled Node.js CodeMetrics tool. Returns the parsed JSON
    {"files": {rel: {...}}, "edges": [...], "framework": "react"|"angular"|"typescript"}."""
    if not TOOL_DIR.exists():
        raise TsToolError(f"TypeScript helper tool not found at {TOOL_DIR}")

    _ensure_tool_deps()

    node = shutil.which("node")
    if not node:
        raise TsToolError("Node.js ('node' on PATH) is required to analyze TypeScript codebases but wasn't found.")

    with tempfile.TemporaryDirectory() as tmp:
        out_path = os.path.join(tmp, "metrics.json")
        try:
            proc = subprocess.run(
                [node, str(TOOL_DIR / "analyze.js"), os.path.abspath(repo_path), out_path],
                capture_output=True, text=True, timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            raise TsToolError(f"CodeMetrics tool timed out after {timeout}s.")

        if proc.returncode != 0 or not os.path.exists(out_path):
            raise TsToolError(
                f"CodeMetrics tool failed (exit {proc.returncode}).\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}"
            )
        with open(out_path, "r", encoding="utf-8") as fh:
            return json.load(fh)


def collect_metrics(repo_path):
    """Returns {'metrics': {rel: {...}}, 'edges': [...], 'source_text': {...},
    'framework': str} — everything analyze_codebase() computes, but *before*
    scoring. See python_analyzer.collect_metrics for why this split exists."""
    files = find_ts_files(repo_path)
    rel_files = [rel for _, rel in files]

    source_text = {}
    for full, rel in files:
        try:
            with open(full, "r", encoding="utf-8", errors="ignore") as fh:
                source_text[rel] = fh.read()
        except Exception:
            source_text[rel] = ""

    tool_output = run_ts_tool(repo_path)
    tool_files = tool_output.get("files", {})
    edges = tool_output.get("edges", [])
    framework = tool_output.get("framework", "typescript")

    churn = scoring.compute_churn(repo_path, rel_files)

    metrics = {}
    for rel in rel_files:
        raw = tool_files.get(rel, {})
        m = {key: raw.get(key, default) for key, default in DEFAULT_FILE_METRICS.items()}
        m["churn"] = churn.get(rel, 0)
        metrics[rel] = m

    return {"metrics": metrics, "edges": edges, "source_text": source_text, "framework": framework}


def analyze_codebase(repo_path):
    """Returns {'files': [...], 'edges': [...], '_source_text': {rel: src}}
    — same contract as python_analyzer.analyze_codebase."""
    collected = collect_metrics(repo_path)
    rows = scoring.compute_debt_scores(collected["metrics"], collected["edges"])
    return {"files": rows, "edges": collected["edges"], "_source_text": collected["source_text"]}
