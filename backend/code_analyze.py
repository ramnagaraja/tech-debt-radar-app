"""
Backward-compatible facade. The real implementations now live under
code_analyzers/ (one module per language) — see code_analyzers/__init__.py
for the registry and code_analyzers/scoring.py for the shared debt-scoring
math every language uses.

Kept so `python3 code_analyze.py <path>` still works standalone for the
Python-only path, and so any external script importing `code_analyze`
directly doesn't break.
"""
from code_analyzers.python_analyzer import (  # noqa: F401
    analyze_codebase,
    build_import_graph,
    compute_complexity,
    compute_design_smells,
    find_py_files,
    run_security_scan,
)
from code_analyzers.scoring import compute_churn, normalize  # noqa: F401

if __name__ == "__main__":
    import json
    import sys

    repo = sys.argv[1] if len(sys.argv) > 1 else "."
    result = analyze_codebase(repo)
    result.pop("_source_text", None)
    print(json.dumps(result, indent=2))
