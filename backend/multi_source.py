"""
Merges analysis results from multiple repositories and/or multiple database
sources into one combined view. When there's exactly one of a source type,
ids pass through completely unprefixed — today's single-repo/single-DB
behavior is unchanged byte-for-byte. Only when there's more than one does
every id get namespaced by that source's slug, so files/tables from
different sources never collide and the combined heatmap/graph stays
meaningful.

Code scoring happens ONCE, across every repo's combined metrics
(code_analyzers.collect_metrics() + code_analyzers.scoring.compute_debt_scores()
called here rather than per-repo) — this is what makes cross-repo
duplicate-code detection possible, and what makes complexity/churn/security
comparable across repos of very different size (normalize() scales values
relative to the whole run, not one repo at a time). Database scoring doesn't
need this: db_analyzers/scoring.py's per-table formulas are already absolute
(row count vs. a fixed 1M-row scale, etc.), not corpus-relative, so each
database source can be scored independently and just merged afterward.
"""
import os
import re

import code_analyzers
import db_analyzers
from code_analyzers import scoring as code_scoring


def slugify(value, existing):
    """Sanitize `value` into a short, id-safe slug, deduping against
    `existing` (a set this call adds to) with -2, -3, ... suffixes."""
    base = re.sub(r"[^a-zA-Z0-9._-]+", "-", (value or "").strip()).strip("-").lower() or "src"
    base = base[:40] or "src"
    slug = base
    n = 2
    while slug in existing:
        slug = f"{base}-{n}"
        n += 1
    existing.add(slug)
    return slug


def analyze_repos(repo_specs):
    """repo_specs: [{"slug", "path", "code_lang"}, ...] — path already
    resolved to a real filesystem directory (cloned, or a local/network path
    as given). Returns {"files": [...scored rows...], "edges": [...],
    "source_text": {namespaced_id: src}, "file_paths": {namespaced_id: abs_path},
    "code_langs": {slug: [resolved_lang, ...]}, "frameworks": {slug: {lang: framework}}}.

    Each repo can itself be more than one language (e.g. a .NET backend
    alongside a separate JS/TS frontend folder) — every language
    code_analyzers.detect_languages() finds gets its own analyzer run
    against the *same* repo path (no subfolder scoping needed: each
    analyzer only ever collects its own file extensions, e.g. the .NET
    analyzer only ever finds .cs files, so running two analyzers over the
    same root can't collide or double-count) and all of them merge into
    that one repo's contribution before the cross-repo namespacing below."""
    single = len(repo_specs) == 1
    combined_metrics, combined_edges, combined_source_text = {}, [], {}
    file_paths, code_langs, frameworks = {}, {}, {}

    for spec in repo_specs:
        slug, path, code_lang = spec["slug"], spec["path"], spec["code_lang"]
        langs = [code_lang] if code_lang != "auto" else sorted(code_analyzers.detect_languages(path))
        prefix = "" if single else f"{slug}/"

        code_langs[slug] = langs
        frameworks[slug] = {}

        for lang in langs:
            collected = code_analyzers.collect_metrics(path, lang=lang)
            if collected.get("framework"):
                frameworks[slug][collected["_code_lang"]] = collected["framework"]

            for rel, m in collected["metrics"].items():
                new_id = prefix + rel
                combined_metrics[new_id] = m
                file_paths[new_id] = os.path.normpath(os.path.join(path, rel))
            for rel, src in collected["source_text"].items():
                combined_source_text[prefix + rel] = src
            for e in collected["edges"]:
                combined_edges.append({**e, "source": prefix + e["source"], "target": prefix + e["target"]})

    rows = code_scoring.compute_debt_scores(combined_metrics, combined_edges)
    solo_slug = repo_specs[0]["slug"] if repo_specs else None
    for row in rows:
        row["repo"] = solo_slug if single else row["id"].split("/", 1)[0]

    return {
        "files": rows, "edges": combined_edges, "source_text": combined_source_text,
        "file_paths": file_paths, "code_langs": code_langs, "frameworks": frameworks,
    }


def analyze_databases(db_specs):
    """db_specs: [{"slug", "source": "connection_string"|"sql_file", "value", "dialect"}, ...].
    Returns {"tables": [...], "edges": [...], "dialects": {slug: resolved_dialect}}."""
    single = len(db_specs) == 1
    tables, edges, dialects = [], [], {}

    for spec in db_specs:
        slug = spec["slug"]
        if spec["source"] == "connection_string":
            result = db_analyzers.analyze_live_db(spec["value"])
            dialects[slug] = db_analyzers.detect_dialect_label(spec["value"])
        else:
            result = db_analyzers.analyze_sql_file(spec["value"], dialect=spec["dialect"])
            dialects[slug] = spec["dialect"]

        prefix = "" if single else f"{slug}."
        id_map = {t["file"]: prefix + t["file"] for t in result["tables"]}
        for t in result["tables"]:
            row = dict(t)
            row["bare_name"] = t["file"]  # pre-namespace name — code references the bare table name, not "db.table"
            row["id"] = id_map[t["file"]]
            row["file"] = id_map[t["file"]]
            row["db"] = slug
            tables.append(row)
        for e in result["edges"]:
            edges.append({
                **e,
                "source": id_map.get(e["source"], prefix + e["source"]),
                "target": id_map.get(e["target"], prefix + e["target"]),
            })

    return {"tables": tables, "edges": edges, "dialects": dialects}
