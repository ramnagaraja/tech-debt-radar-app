"""
Registry over per-language code analyzers. Every analyzer module exposes
`analyze_codebase(repo_path) -> {"files": [...], "edges": [...], "_source_text": {...}}`
in the exact same shape (see code_analyzers/scoring.py for the shared
per-file row contract), so app.py and the frontend never need to know which
language produced a given row.
"""
import os

SUPPORTED_LANGUAGES = ("python", "dotnet")

_DOTNET_EXCLUDE_DIRS = {".git", "bin", "obj", "node_modules", "packages"}


def detect_language(repo_path):
    """Best-effort auto-detection: a .sln or .csproj anywhere means .NET;
    otherwise fall back to Python if there's at least one .py file."""
    has_py = False
    for root, dirs, fnames in os.walk(repo_path):
        dirs[:] = [d for d in dirs if d not in _DOTNET_EXCLUDE_DIRS and d not in (".git",)]
        for f in fnames:
            if f.endswith(".sln") or f.endswith(".csproj"):
                return "dotnet"
            if f.endswith(".py"):
                has_py = True
    return "python" if has_py else "unknown"


def get_analyzer(lang):
    if lang == "python":
        from . import python_analyzer
        return python_analyzer
    if lang == "dotnet":
        from . import dotnet_analyzer
        return dotnet_analyzer
    raise ValueError(f"Unsupported code_lang: {lang!r}. Supported: {SUPPORTED_LANGUAGES}")


def analyze_codebase(repo_path, lang="auto"):
    resolved = detect_language(repo_path) if lang == "auto" else lang
    if resolved == "unknown":
        resolved = "python"  # safest default: an empty result is more useful than a hard error
    analyzer = get_analyzer(resolved)
    result = analyzer.analyze_codebase(repo_path)
    result["_code_lang"] = resolved
    return result
