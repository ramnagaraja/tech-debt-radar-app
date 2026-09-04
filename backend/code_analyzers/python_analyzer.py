"""
Python code-side analysis: complexity (radon) + churn (git log) + import
dependency graph (ast) + security (bandit) + design/best-practices (radon
maintainability index). Callable as a function from app.py, or standalone
via CLI.
"""
import ast
import json
import os
import subprocess
from collections import defaultdict

from radon.complexity import cc_visit
from radon.metrics import mi_visit
from radon.raw import analyze as raw_analyze

from . import scoring

EXCLUDE_DIRS = {".git", "__pycache__", "venv", ".venv", "env", "build", "dist",
                "node_modules", "migrations", ".mypy_cache", ".pytest_cache"}

BANDIT_SEVERITY_WEIGHT = {"LOW": 1.0, "MEDIUM": 3.0, "HIGH": 6.0}
BANDIT_CONFIDENCE_WEIGHT = {"LOW": 0.5, "MEDIUM": 0.75, "HIGH": 1.0}


def run_security_scan(repo_path):
    """Real static security analysis via bandit. Returns {rel_file: {...}}.
    Weighted by both severity and bandit's own confidence in the finding, so
    a single LOW/HIGH-confidence hit (e.g. bare `assert`) barely moves the
    score while a HIGH-severity finding (hardcoded secret, eval, SQL string
    building, etc.) dominates it."""
    abs_repo = os.path.abspath(repo_path)
    try:
        proc = subprocess.run(
            ["bandit", "-r", abs_repo, "-f", "json", "-q", "--skip", "B101"],
            capture_output=True, text=True, timeout=180,
        )
        data = json.loads(proc.stdout) if proc.stdout.strip() else {"results": []}
    except (subprocess.TimeoutExpired, FileNotFoundError, json.JSONDecodeError):
        return {}

    by_file = defaultdict(lambda: {"count": 0, "weighted": 0.0, "high_severity_count": 0, "issues": []})
    for r in data.get("results", []):
        try:
            rel = os.path.relpath(r["filename"], abs_repo)
        except ValueError:
            continue
        sw = BANDIT_SEVERITY_WEIGHT.get(r.get("issue_severity"), 1.0)
        cw = BANDIT_CONFIDENCE_WEIGHT.get(r.get("issue_confidence"), 0.5)
        entry = by_file[rel]
        entry["count"] += 1
        entry["weighted"] += sw * cw
        if r.get("issue_severity") == "HIGH":
            entry["high_severity_count"] += 1
        if len(entry["issues"]) < 5:
            entry["issues"].append({
                "severity": r.get("issue_severity"), "confidence": r.get("issue_confidence"),
                "test_id": r.get("test_id"), "text": (r.get("issue_text") or "")[:160],
                "line": r.get("line_number"),
            })
    return dict(by_file)


def compute_design_smells(full_path, loc):
    """Real ast-derived design signals — not just an inverted maintainability
    index. Each is independently computable and explainable:
      - long functions (>50 lines): a classic 'do too much' smell
      - deep nesting (>4 levels of if/for/while/try): hard-to-follow control flow
      - too many parameters (>5): a signal the function's doing too much / needs a parameter object
      - god file (>500 lines): the file itself has grown too large to reason about
    """
    try:
        with open(full_path, "r", encoding="utf-8", errors="ignore") as fh:
            src = fh.read()
        tree = ast.parse(src)
    except Exception:
        return {"long_function_count": 0, "max_nesting_depth": 0, "many_params_count": 0, "god_file": False}

    long_function_count = 0
    many_params_count = 0
    max_nesting_depth = 0
    NESTING_NODES = (ast.If, ast.For, ast.While, ast.Try, ast.With, ast.AsyncFor, ast.AsyncWith)

    def walk_depth(node, depth):
        nonlocal max_nesting_depth
        max_nesting_depth = max(max_nesting_depth, depth)
        for child in ast.iter_child_nodes(node):
            walk_depth(child, depth + 1 if isinstance(child, NESTING_NODES) else depth)

    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            start = node.lineno
            end = getattr(node, "end_lineno", start)
            if (end - start) > 50:
                long_function_count += 1
            params = [p for p in (node.args.args + node.args.kwonlyargs) if p.arg not in ("self", "cls")]
            if len(params) > 5:
                many_params_count += 1
            walk_depth(node, 0)

    return {
        "long_function_count": long_function_count,
        "max_nesting_depth": max_nesting_depth,
        "many_params_count": many_params_count,
        "god_file": loc > 500,
    }


def find_py_files(repo_path):
    files = []
    for root, dirs, fnames in os.walk(repo_path):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for f in fnames:
            if f.endswith(".py"):
                full = os.path.join(root, f)
                rel = os.path.relpath(full, repo_path).replace(os.sep, "/")
                files.append((full, rel))
    return files


def compute_complexity(full_path):
    try:
        with open(full_path, "r", encoding="utf-8", errors="ignore") as fh:
            src = fh.read()
        blocks = cc_visit(src)
        avg_cc = sum(b.complexity for b in blocks) / len(blocks) if blocks else 0.0
        max_cc = max((b.complexity for b in blocks), default=0)
        mi = mi_visit(src, multi=True)
        raw = raw_analyze(src)
        return {
            "avg_complexity": round(avg_cc, 2),
            "max_complexity": max_cc,
            "maintainability_index": round(mi, 2),
            "loc": raw.loc,
            "sloc": raw.sloc,
            "function_count": len(blocks),
        }
    except Exception as e:
        return {"avg_complexity": 0, "max_complexity": 0, "maintainability_index": 100,
                "loc": 0, "sloc": 0, "function_count": 0, "error": str(e)}


def build_import_graph(repo_path, rel_files):
    module_to_file = {}
    for rel in rel_files:
        mod = rel[:-3].replace(os.sep, ".").replace("/", ".")
        module_to_file[mod] = rel
        if mod.endswith(".__init__"):
            module_to_file[mod[: -len(".__init__")]] = rel

    edges = []
    for full, rel in [(os.path.join(repo_path, r), r) for r in rel_files]:
        try:
            with open(full, "r", encoding="utf-8", errors="ignore") as fh:
                tree = ast.parse(fh.read(), filename=rel)
        except SyntaxError:
            continue
        pkg_parts = rel[:-3].replace(os.sep, "/").split("/")[:-1]
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imported.add(alias.name)
            elif isinstance(node, ast.ImportFrom):
                if node.level and node.level > 0:
                    base = pkg_parts[: len(pkg_parts) - (node.level - 1)] if node.level > 1 else pkg_parts
                    base = base if node.level <= len(pkg_parts) + 1 else []
                    resolved = ".".join(base + ([node.module] if node.module else []))
                    if resolved:
                        imported.add(resolved)
                elif node.module:
                    imported.add(node.module)
        for imp in imported:
            candidates = [m for m in module_to_file if imp == m or imp.startswith(m + ".") or m.startswith(imp + ".")]
            for c in candidates:
                target = module_to_file[c]
                if target != rel:
                    edges.append({"source": rel, "target": target, "edge_type": "code_import"})
    seen, unique_edges = set(), []
    for e in edges:
        key = (e["source"], e["target"])
        if key not in seen:
            seen.add(key)
            unique_edges.append(e)
    return unique_edges


def analyze_codebase(repo_path):
    """Returns {'files': [...], 'edges': [...], 'raw_source_text': {rel: src}}"""
    files = find_py_files(repo_path)
    rel_files = [rel for _, rel in files]
    churn = scoring.compute_churn(repo_path, rel_files)
    security_by_file = run_security_scan(repo_path)

    metrics = {}
    source_text = {}
    for full, rel in files:
        m = compute_complexity(full)
        m["churn"] = churn.get(rel, 0)
        sec = security_by_file.get(rel, {"count": 0, "weighted": 0.0, "high_severity_count": 0, "issues": []})
        m["security_issue_count"] = sec["count"]
        m["security_high_count"] = sec["high_severity_count"]
        m["security_weighted"] = round(sec["weighted"], 2)
        m["security_issues"] = sec["issues"]
        m.update(compute_design_smells(full, m["loc"]))
        metrics[rel] = m
        try:
            with open(full, "r", encoding="utf-8", errors="ignore") as fh:
                source_text[rel] = fh.read()
        except Exception:
            source_text[rel] = ""

    edges = build_import_graph(repo_path, rel_files)
    rows = scoring.compute_debt_scores(metrics, edges)
    return {"files": rows, "edges": edges, "_source_text": source_text}


if __name__ == "__main__":
    import sys
    repo = sys.argv[1] if len(sys.argv) > 1 else "."
    result = analyze_codebase(repo)
    result.pop("_source_text", None)
    print(json.dumps(result, indent=2))
