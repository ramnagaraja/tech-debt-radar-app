"""
Python code-side analysis: complexity (radon) + churn (git log) + import
dependency graph (ast) + security (bandit) + design/best-practices (radon
maintainability index). Callable as a function from app.py, or standalone
via CLI.
"""
import ast
import hashlib
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


MIN_HASHED_FUNCTION_LINES = 3  # skip trivial one-line getters/props when hashing for duplication
LONG_CHAIN_BRANCH_THRESHOLD = 5


def _normalize_node_for_hash(node):
    """Structural fingerprint of an AST subtree with identifier names and
    literal values blanked out, so two functions that are copy-pasted with
    renamed variables/different constants still hash identically — a real
    (if approximate) reusability/duplication signal, not just 'same LOC'."""
    if isinstance(node, ast.AST):
        parts = [type(node).__name__]
        for field_name, value in ast.iter_fields(node):
            if isinstance(node, ast.Name) and field_name == "id":
                parts.append("NAME")
            elif isinstance(node, ast.arg) and field_name == "arg":
                parts.append("ARG")
            elif isinstance(node, ast.Constant) and field_name == "value":
                parts.append("CONST")
            elif isinstance(node, ast.Attribute) and field_name == "attr":
                parts.append("ATTR")
            elif isinstance(value, list):
                parts.append("[" + ",".join(_normalize_node_for_hash(v) for v in value) + "]")
            elif isinstance(value, ast.AST):
                parts.append(_normalize_node_for_hash(value))
        return "(" + ",".join(parts) + ")"
    return ""


def _function_hash(node):
    start = node.lineno
    end = getattr(node, "end_lineno", start)
    if (end - start) < MIN_HASHED_FUNCTION_LINES:
        return None
    shape = _normalize_node_for_hash(node)
    return hashlib.sha1(shape.encode("utf-8")).hexdigest()[:16]


def _if_chain_branch_count(if_node):
    """Counts if + elif + (1 for a trailing plain else) for the chain
    starting at if_node — an elif is represented in the AST as a single-item
    orelse containing another If, so we walk that chain rather than treating
    each elif as its own independent if."""
    count = 1
    node = if_node
    while len(node.orelse) == 1 and isinstance(node.orelse[0], ast.If):
        count += 1
        node = node.orelse[0]
    if node.orelse:
        count += 1
    return count


def compute_design_smells(full_path, loc):
    """Real ast-derived design signals — not just an inverted maintainability
    index. Each is independently computable and explainable:
      - long functions (>50 lines): a classic 'do too much' smell
      - deep nesting (>4 levels of if/for/while/try): hard-to-follow control flow
      - too many parameters (>5): a signal the function's doing too much / needs a parameter object
      - god file (>500 lines): the file itself has grown too large to reason about
      - duplicate/near-duplicate function bodies (reusability): a structural
        hash per function, compared across the whole analysis run in
        scoring.compute_duplicate_counts (this function only emits the hash)
      - high public surface (SRP/god-class proxy): count of non-underscore
        top-level functions/methods
      - long if/elif or match/case chains (>5 branches): an OCP proxy —
        'this probably wants to be polymorphism/a strategy map instead'
    """
    empty = {
        "long_function_count": 0, "max_nesting_depth": 0, "many_params_count": 0, "god_file": False,
        "function_hashes": [], "public_function_count": 0, "long_conditional_chain_count": 0,
    }
    try:
        with open(full_path, "r", encoding="utf-8", errors="ignore") as fh:
            src = fh.read()
        tree = ast.parse(src)
    except Exception:
        return empty

    long_function_count = 0
    many_params_count = 0
    max_nesting_depth = 0
    public_function_count = 0
    function_hashes = []
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
            if not node.name.startswith("_"):
                public_function_count += 1
            h = _function_hash(node)
            if h:
                function_hashes.append(h)
            walk_depth(node, 0)

    # If/elif chains: skip elif-continuations so a 6-branch chain counts once,
    # not once per elif. match/case (Python's actual switch) counts directly.
    elif_continuations = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.If):
            n = node
            while len(n.orelse) == 1 and isinstance(n.orelse[0], ast.If):
                elif_continuations.add(id(n.orelse[0]))
                n = n.orelse[0]

    long_conditional_chain_count = 0
    for node in ast.walk(tree):
        if isinstance(node, ast.If) and id(node) not in elif_continuations:
            if _if_chain_branch_count(node) > LONG_CHAIN_BRANCH_THRESHOLD:
                long_conditional_chain_count += 1
        elif isinstance(node, getattr(ast, "Match", ())) and len(node.cases) > LONG_CHAIN_BRANCH_THRESHOLD:
            long_conditional_chain_count += 1

    return {
        "long_function_count": long_function_count,
        "max_nesting_depth": max_nesting_depth,
        "many_params_count": many_params_count,
        "god_file": loc > 500,
        "function_hashes": function_hashes,
        "public_function_count": public_function_count,
        "long_conditional_chain_count": long_conditional_chain_count,
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


def collect_metrics(repo_path):
    """Returns {'metrics': {rel: {...}}, 'edges': [...], 'source_text': {...}}
    — everything analyze_codebase() computes, but *before* scoring.
    compute_debt_scores() is applied. Kept separate so multi_source.py can
    merge several repos' metrics and score them together in one pass (this
    is what makes cross-repo duplicate-code detection and cross-repo-relative
    normalization possible — scoring one repo at a time would silently miss
    both)."""
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
    return {"metrics": metrics, "edges": edges, "source_text": source_text}


def analyze_codebase(repo_path):
    """Returns {'files': [...], 'edges': [...], '_source_text': {rel: src}}
    — single-repo entry point (standalone CLI use, and the shape
    code_analyzers/__init__.py's analyze_codebase() dispatches to)."""
    collected = collect_metrics(repo_path)
    rows = scoring.compute_debt_scores(collected["metrics"], collected["edges"])
    return {"files": rows, "edges": collected["edges"], "_source_text": collected["source_text"]}


if __name__ == "__main__":
    import sys
    repo = sys.argv[1] if len(sys.argv) > 1 else "."
    result = analyze_codebase(repo)
    result.pop("_source_text", None)
    print(json.dumps(result, indent=2))
