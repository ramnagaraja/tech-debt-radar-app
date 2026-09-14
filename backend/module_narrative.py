"""
AI-authored module/architecture narratives.

Groups the files an analysis run already produced into modules (one folder
level under each repo root), aggregates their debt metrics, and asks the
configured LLM to describe each module's apparent role, responsibilities,
and debt concerns in plain language grounded in the actual metrics and a
sample of the actual source — the onboarding paragraph a new engineer on
the team wishes already existed for "what even is this folder for".

Purely additive: it consumes the same `files` list and `source_text` dict
every analysis run already builds (see multi_source.analyze_repos), adds no
new static analysis, and caches its output keyed by a content hash so
re-opening the dashboard's Architecture tab doesn't re-call the LLM unless
that module's file list or metrics actually changed since the cached
narrative was generated.
"""
import hashlib
import json

import llm_providers

MODULE_DEPTH = 2          # path segments under the repo slug that define one module
MAX_SAMPLE_CHARS = 6000   # total source characters sent to the LLM per module
MAX_FILES_LISTED = 40     # files listed by name/metrics in the prompt (all of them still count toward the aggregates)
MAX_EXCERPT_FILES = 5     # highest-debt files a source excerpt is pulled from

NARRATIVE_SYSTEM_PROMPT = (
    "You are writing a short architecture narrative for one module (folder) of a "
    "codebase, for an engineer who has never seen this code before. You are given "
    "the module's file list with debt metrics, and short source excerpts from its "
    "highest-debt files. Respond with ONLY strict JSON, no prose before or after: "
    '{"role": "one sentence - what this module appears to be for", '
    '"responsibilities": ["short bullet", "..."], '
    '"key_files": ["path - why it matters", "..."], '
    '"concerns": ["specific debt/design concern grounded in the metrics or excerpts shown", "..."]}. '
    "Ground every claim in the file list, metrics, or excerpts given - never invent "
    "a file name, framework, or behavior that wasn't shown to you. If the excerpts "
    "don't support a confident concern, say so briefly (e.g. \"no excerpt available "
    "for the highest-debt file\") rather than inventing one."
)


def module_key(file_id, repo_slug):
    """Namespacing elsewhere in the app is "{repo_slug}/{relative/path}"; a
    module is the first MODULE_DEPTH path segments of the relative part,
    e.g. "myrepo/backend/api" at depth 2 for "myrepo/backend/api/routes.py".
    Falls back to the bare repo slug for files sitting at the repo root."""
    if not file_id.startswith(repo_slug + "/"):
        return repo_slug
    rest = file_id[len(repo_slug) + 1:]
    parts = rest.split("/")[:-1]  # drop the filename itself
    if not parts:
        return repo_slug
    return repo_slug + "/" + "/".join(parts[:MODULE_DEPTH])


def group_into_modules(files, repo_slugs):
    """files: the full analyzed file list (each dict has "file", "debt_score",
    "loc", ...). repo_slugs: known repo slugs for this run, longest-prefix
    matched against each file id (a slug can itself contain "/"). Returns
    {module_id: [file, ...]}, insertion-ordered by first appearance."""
    modules = {}
    sorted_slugs = sorted(repo_slugs, key=len, reverse=True)
    for f in files:
        slug = next((s for s in sorted_slugs if f["file"].startswith(s + "/") or f["file"] == s), None)
        mid = module_key(f["file"], slug) if slug else (f["file"].rsplit("/", 1)[0] or f["file"])
        modules.setdefault(mid, []).append(f)
    return modules


def content_hash(file_list):
    """Stable hash over (file, debt_score, loc) — changes whenever this
    module's composition or metrics change, not on every analysis run of an
    unrelated module, so a cached narrative survives re-analyses that don't
    touch this module."""
    basis = sorted((f["file"], round(f.get("debt_score", 0) or 0, 4), f.get("loc", 0)) for f in file_list)
    return hashlib.sha256(json.dumps(basis).encode()).hexdigest()[:16]


def build_module_summary(module_id, file_list):
    by_debt = sorted(file_list, key=lambda f: f.get("debt_score", 0) or 0, reverse=True)
    avg_debt = round(sum((f.get("debt_score", 0) or 0) for f in file_list) / len(file_list), 4) if file_list else 0
    return {
        "module_id": module_id,
        "file_count": len(file_list),
        "total_loc": sum(f.get("loc", 0) or 0 for f in file_list),
        "avg_debt": avg_debt,
        "high_debt_count": sum(1 for f in file_list if (f.get("debt_score", 0) or 0) >= 0.6),
        "top_files": [{"file": f["file"], "debt_score": f.get("debt_score", 0)} for f in by_debt[:8]],
        "content_hash": content_hash(file_list),
    }


def generate_narrative(module_id, file_list, source_text, provider, model, api_key, base_url=None):
    """Calls the configured LLM once for this module. Returns
    {"ok": True, "narrative": {...}} or {"ok": False, "error": "..."} —
    never raises, so one module's narrative failure never blocks the rest."""
    by_debt = sorted(file_list, key=lambda f: f.get("debt_score", 0) or 0, reverse=True)
    listed = by_debt[:MAX_FILES_LISTED]
    file_lines = "\n".join(
        f"- {f['file']} (debt {f.get('debt_score', 0) or 0:.2f}, loc {f.get('loc', 0) or 0})" for f in listed
    )
    if len(file_list) > len(listed):
        file_lines += f"\n… and {len(file_list) - len(listed)} more file(s) in this module."

    excerpts = []
    budget = MAX_SAMPLE_CHARS
    for f in by_debt[:MAX_EXCERPT_FILES]:
        text = (source_text or {}).get(f["file"])
        if not text or budget <= 0:
            continue
        chunk = text[:min(1500, budget)]
        excerpts.append(f"--- {f['file']} ---\n{chunk}")
        budget -= len(chunk)

    user_content = (
        f"Module: {module_id}\n\n"
        f"Files ({len(file_list)} total, {len(listed)} shown):\n{file_lines}\n\n"
        f"Source excerpts from the highest-debt files:\n\n" + ("\n\n".join(excerpts) if excerpts else "(no source available for excerpting)")
    )
    try:
        text = llm_providers.call_llm(
            provider, model, api_key, NARRATIVE_SYSTEM_PROMPT,
            [{"role": "user", "content": user_content}], max_tokens=1800, base_url=base_url,
        )
        narrative = llm_providers.extract_json(text, expect="object")
        for key in ("role", "responsibilities", "key_files", "concerns"):
            narrative.setdefault(key, [] if key != "role" else "")
        return {"ok": True, "narrative": narrative}
    except Exception as e:
        return {"ok": False, "error": f"Could not generate narrative: {e}"}
