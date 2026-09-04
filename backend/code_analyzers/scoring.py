"""
Language-agnostic pieces of code-side debt scoring: git churn and the final
normalize -> weighted-composite -> sorted-rows assembly. Every per-language
analyzer (python_analyzer.py, dotnet_analyzer.py, ...) computes its own raw
per-file metrics (complexity, security findings, design smells) however
makes sense for that language, then hands them to `compute_debt_scores`
here so every language ends up scored the same way and is directly
comparable in the combined heatmap.
"""
import subprocess
from collections import defaultdict


def normalize(values):
    if not values:
        return {}
    lo, hi = min(values), max(values)
    if hi == lo:
        return {v: 0.5 for v in values}
    return {v: (v - lo) / (hi - lo) for v in values}


def compute_churn(repo_path, rel_files, since="2 years ago"):
    churn = defaultdict(int)
    try:
        out = subprocess.run(
            ["git", "-C", repo_path, "log", f"--since={since}", "--name-only", "--pretty=format:"],
            capture_output=True, text=True, check=True, timeout=60,
        ).stdout
        rel_set = set(rel_files)
        for line in out.splitlines():
            line = line.strip()
            if line and line in rel_set:
                churn[line] += 1
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return churn


REQUIRED_METRIC_KEYS = (
    "loc", "sloc", "avg_complexity", "max_complexity", "maintainability_index",
    "function_count", "churn", "security_issue_count", "security_high_count",
    "security_weighted", "security_issues", "long_function_count",
    "max_nesting_depth", "many_params_count", "god_file",
    "function_hashes", "public_function_count", "long_conditional_chain_count",
)

def compute_duplicate_counts(metrics_by_rel):
    """Cross-file duplicate-function detection: any normalized function-body
    hash appearing 2+ times across the whole run (every file, and — since
    metrics_by_rel already spans every analyzed repo when multiple are
    merged — every repo) marks each participating file. This is the
    reusability signal in design_detail, and the concrete payoff of
    analyzing related repos together: it catches the same logic
    copy-pasted across services, not just within one file. Each language's
    analyzer is responsible for only emitting hashes for bodies big enough
    to matter (skipping trivial one-line getters) before they reach here."""
    hash_locations = defaultdict(list)
    for rel, m in metrics_by_rel.items():
        for h in m.get("function_hashes") or []:
            hash_locations[h].append(rel)

    counts = defaultdict(int)
    for rels in hash_locations.values():
        if len(rels) >= 2:
            for rel in rels:
                counts[rel] += 1
    return counts


def compute_debt_scores(metrics_by_rel, edges):
    """metrics_by_rel: {rel_path: {...REQUIRED_METRIC_KEYS}}. edges: [{source, target, edge_type}].
    Returns file rows sorted by debt_score desc, in the shape the frontend
    (Dashboard.jsx) and write_sqlite() expect — identical for every language."""
    fan_in, fan_out = defaultdict(int), defaultdict(int)
    for e in edges:
        fan_out[e["source"]] += 1
        fan_in[e["target"]] += 1

    duplicate_counts = compute_duplicate_counts(metrics_by_rel)

    complexities = [m["avg_complexity"] for m in metrics_by_rel.values()]
    churns = [m["churn"] for m in metrics_by_rel.values()]
    security_vals = [m["security_weighted"] for m in metrics_by_rel.values()]
    mi_penalties = [max(0.0, 100.0 - m["maintainability_index"]) for m in metrics_by_rel.values()]
    long_func_vals = [m["long_function_count"] for m in metrics_by_rel.values()]
    nesting_vals = [m["max_nesting_depth"] for m in metrics_by_rel.values()]
    params_vals = [m["many_params_count"] for m in metrics_by_rel.values()]
    god_file_vals = [1 if m["god_file"] else 0 for m in metrics_by_rel.values()]
    dup_vals = [duplicate_counts.get(rel, 0) for rel in metrics_by_rel]
    public_surface_vals = [m["public_function_count"] for m in metrics_by_rel.values()]
    long_cond_vals = [m["long_conditional_chain_count"] for m in metrics_by_rel.values()]

    norm_c = normalize(complexities)
    norm_ch = normalize(churns)
    norm_sec = normalize(security_vals)
    norm_mi = normalize(mi_penalties)
    norm_long_func = normalize(long_func_vals)
    norm_nesting = normalize(nesting_vals)
    norm_params = normalize(params_vals)
    norm_god = normalize(god_file_vals)
    norm_dup = normalize(dup_vals)
    norm_public = normalize(public_surface_vals)
    norm_cond = normalize(long_cond_vals)

    rows = []
    for rel, m in metrics_by_rel.items():
        c_score = norm_c.get(m["avg_complexity"], 0)
        ch_score = norm_ch.get(m["churn"], 0)
        sec_score = norm_sec.get(m["security_weighted"], 0)

        mi_pen = max(0.0, 100.0 - m["maintainability_index"])
        design_detail = {
            "maintainability": round(norm_mi.get(mi_pen, 0), 3),
            "long_functions": round(norm_long_func.get(m["long_function_count"], 0), 3),
            "deep_nesting": round(norm_nesting.get(m["max_nesting_depth"], 0), 3),
            "many_params": round(norm_params.get(m["many_params_count"], 0), 3),
            "god_file": round(norm_god.get(1 if m["god_file"] else 0, 0), 3),
            "duplicate_code": round(norm_dup.get(duplicate_counts.get(rel, 0), 0), 3),
            "high_public_surface": round(norm_public.get(m["public_function_count"], 0), 3),
            "long_conditional_chains": round(norm_cond.get(m["long_conditional_chain_count"], 0), 3),
        }
        design_score = round(sum(design_detail.values()) / len(design_detail), 4)

        # weighted composite: complexity 35% / churn 20% / security 25% / design 20%
        debt_score = round(0.35 * c_score + 0.20 * ch_score + 0.25 * sec_score + 0.20 * design_score, 4)
        rows.append({
            "id": rel, "kind": "file", "file": rel,
            "loc": m["loc"], "sloc": m["sloc"],
            "avg_complexity": m["avg_complexity"], "max_complexity": m["max_complexity"],
            "maintainability_index": m["maintainability_index"], "function_count": m["function_count"],
            "churn": m["churn"], "fan_in": fan_in.get(rel, 0), "fan_out": fan_out.get(rel, 0),
            "security_issue_count": m["security_issue_count"], "security_high_count": m["security_high_count"],
            "security_issues": m["security_issues"],
            "long_function_count": m["long_function_count"], "max_nesting_depth": m["max_nesting_depth"],
            "many_params_count": m["many_params_count"], "god_file": m["god_file"],
            "duplicate_function_count": duplicate_counts.get(rel, 0),
            "public_function_count": m["public_function_count"],
            "long_conditional_chain_count": m["long_conditional_chain_count"],
            "score_breakdown": {"complexity": round(c_score, 3), "churn": round(ch_score, 3),
                                 "security": round(sec_score, 3), "design": design_score,
                                 "design_detail": design_detail},
            "debt_score": debt_score,
        })
    rows.sort(key=lambda r: r["debt_score"], reverse=True)
    return rows
