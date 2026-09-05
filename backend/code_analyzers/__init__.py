"""
Registry over per-language code analyzers. Every analyzer module exposes
`analyze_codebase(repo_path) -> {"files": [...], "edges": [...], "_source_text": {...}}`
in the exact same shape (see code_analyzers/scoring.py for the shared
per-file row contract), so app.py and the frontend never need to know which
language produced a given row.
"""
import os

SUPPORTED_LANGUAGES = ("python", "dotnet", "typescript")

_EXCLUDE_DIRS = {".git", "bin", "obj", "node_modules", "packages", "dist", "build", ".angular"}


_LANGUAGE_PRIORITY = ("dotnet", "typescript", "python")


def detect_languages(repo_path):
    """Every language actually present in repo_path, not just the
    highest-priority one — a repo that bundles a .NET backend with a
    separate JS/TS frontend folder (a common real-world layout) is
    genuinely more than one language, and analyzing only the first one
    found silently drops the rest.

    - "dotnet": any .sln/.csproj anywhere (a strong, unambiguous signal).
    - "python": any .py file anywhere (unchanged from the original
      single-language rule).
    - "typescript": any real .ts/.tsx file anywhere (also unambiguous on
      its own), OR a package.json anywhere alongside at least one .js/.jsx
      file anywhere in the repo. The package.json gate matters because
      plain .js counts too now (see typescript_analyzer.py) — without it, a
      single stray .js build/config script in an otherwise pure Python/.NET
      repo would wrongly flag the whole repo as "also TypeScript".

    Returns {"unknown"} if nothing matches."""
    has_py = has_dotnet = has_real_ts = has_js = has_package_json = False
    for root, dirs, fnames in os.walk(repo_path):
        dirs[:] = [d for d in dirs if d not in _EXCLUDE_DIRS]
        for f in fnames:
            if f.endswith(".sln") or f.endswith(".csproj"):
                has_dotnet = True
            elif f.endswith(".py"):
                has_py = True
            if f == "package.json":
                has_package_json = True
            elif f.endswith((".ts", ".tsx")) and not f.endswith(".d.ts"):
                has_real_ts = True
            elif f.endswith((".js", ".jsx")):
                has_js = True

    found = set()
    if has_dotnet:
        found.add("dotnet")
    if has_py:
        found.add("python")
    if has_real_ts or (has_package_json and has_js):
        found.add("typescript")
    return found or {"unknown"}


def detect_language(repo_path):
    """Single highest-priority language, for callers that only want one
    label (e.g. a quick "what is this" check) — see detect_languages()
    for the full set actually present."""
    found = detect_languages(repo_path)
    for lang in _LANGUAGE_PRIORITY:
        if lang in found:
            return lang
    return "unknown"


def get_analyzer(lang):
    if lang == "python":
        from . import python_analyzer
        return python_analyzer
    if lang == "dotnet":
        from . import dotnet_analyzer
        return dotnet_analyzer
    if lang == "typescript":
        from . import typescript_analyzer
        return typescript_analyzer
    raise ValueError(f"Unsupported code_lang: {lang!r}. Supported: {SUPPORTED_LANGUAGES}")


def _resolve(repo_path, lang):
    resolved = detect_language(repo_path) if lang == "auto" else lang
    if resolved == "unknown":
        resolved = "python"  # safest default: an empty result is more useful than a hard error
    return resolved


def analyze_codebase(repo_path, lang="auto"):
    resolved = _resolve(repo_path, lang)
    result = get_analyzer(resolved).analyze_codebase(repo_path)
    result["_code_lang"] = resolved
    return result


def collect_metrics(repo_path, lang="auto"):
    """Unscored per-file metrics (see python_analyzer.collect_metrics) —
    used by multi_source.py to merge several repos before scoring them
    together in one pass."""
    resolved = _resolve(repo_path, lang)
    result = get_analyzer(resolved).collect_metrics(repo_path)
    result["_code_lang"] = resolved
    result.setdefault("framework", None)  # only typescript_analyzer.py sets this
    return result
