"""
Tech Debt Radar — end-user app backend.

Run:
    pip install -r requirements.txt
    export ANTHROPIC_API_KEY=sk-ant-...
    python3 app.py
    open http://localhost:8000
"""
import json
import os
import shutil
import sqlite3
import stat
import subprocess
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

# Put your key directly here if you'd rather not use an environment variable.
# Anything in ANTHROPIC_API_KEY (if set) still wins, so you can override this
# without editing the file again later.
HARDCODED_ANTHROPIC_API_KEY = "sk-ant-REPLACE-WITH-YOUR-KEY"

from fastapi import FastAPI, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

import code_analyzers
import coupling_analyzer
import db_analyzers
import external_context
import graph_queries
import knowledge_base
import llm_providers
import module_narrative
import multi_source
import pr_context

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "app_data"
DATA_DIR.mkdir(exist_ok=True)
DB_PATH = DATA_DIR / "debt_radar.db"
APP_DB_PATH = DATA_DIR / "app.db"          # settings + feedback — survives across re-analyses
METRICS_PATH = DATA_DIR / "dashboard_data.json"
CLONE_DIR = DATA_DIR / "clones"
CLONE_DIR.mkdir(exist_ok=True)

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

JOB = {"status": "idle", "step": "", "error": None}  # single-job app — one analysis at a time
FILE_PATHS = {}    # {namespaced_file_id: absolute_path}, rebuilt on every analysis — backs /api/file-source
SOURCE_TEXT = {}    # {namespaced_file_id: raw text}, rebuilt on every analysis — backs on-demand module narrative generation
REPO_SLUGS = []      # slugs seen in the most recent analysis — backs module grouping and PR mining's repo->path lookup
REPO_PATHS = {}    # {slug: local filesystem path} — used by PR mining to run `git remote get-url origin` against the right clone
PR_MINING_JOBS = {}  # {repo_slug: {"status": "idle"|"running"|"done"|"error", "error": str|None}}


def init_app_db():
    conn = sqlite3.connect(APP_DB_PATH)
    cur = conn.cursor()
    cur.execute("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)")
    cur.execute("""CREATE TABLE IF NOT EXISTS chat_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT, answer TEXT,
        vote TEXT, node_id TEXT, created_at TEXT)""")

    # --- trend history: additive, never dropped on re-analysis (unlike the
    # snapshot tables in DB_PATH/write_sqlite) so a run's numbers stay
    # queryable after the next run overwrites the "current" snapshot. ---
    cur.execute("""CREATE TABLE IF NOT EXISTS analysis_runs (
        run_id INTEGER PRIMARY KEY AUTOINCREMENT, generated_at TEXT, repo_label TEXT,
        total_files INTEGER, total_tables INTEGER, total_edges INTEGER,
        avg_code_debt REAL, avg_db_debt REAL, high_debt_count INTEGER)""")
    cur.execute("""CREATE TABLE IF NOT EXISTS node_debt_history (
        run_id INTEGER, node_id TEXT, kind TEXT, debt_score REAL,
        FOREIGN KEY(run_id) REFERENCES analysis_runs(run_id))""")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_node_debt_history_node ON node_debt_history(node_id)")

    # --- PR-history mining results, keyed loosely by file suffix so a PR's
    # file path ("backend/app.py") still matches our namespaced file id
    # ("myrepo/backend/app.py") without requiring an exact match. ---
    cur.execute("""CREATE TABLE IF NOT EXISTS pr_insights (
        id INTEGER PRIMARY KEY AUTOINCREMENT, repo_slug TEXT, file_hint TEXT,
        insight TEXT, source_pr INTEGER, created_at TEXT)""")

    # --- cached AI module narratives, keyed by module id + a content hash so
    # a narrative is only regenerated when its module's files/metrics change. ---
    cur.execute("""CREATE TABLE IF NOT EXISTS module_narratives (
        module_id TEXT PRIMARY KEY, content_hash TEXT, summary_json TEXT,
        narrative_json TEXT, status TEXT, error TEXT, generated_at TEXT)""")

    # --- MCP-proposed annotations on a graph node. Nothing here ever changes
    # a debt score or the graph itself — annotate_node (the MCP server's one
    # write tool) only ever inserts a "pending" row; a human approves or
    # rejects it from the Admin panel. ---
    cur.execute("""CREATE TABLE IF NOT EXISTS graph_annotations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT, note TEXT, author TEXT,
        status TEXT DEFAULT 'pending', created_at TEXT, decided_at TEXT)""")

    conn.commit()
    conn.close()


init_app_db()

# Ingests the bundled SOLID/design-pattern/microservices reference docs into
# the knowledge base on first run (idempotent, see ensure_builtin_seed_documents).
# Backgrounded because the first-ever call also lazily loads the local
# embedding model, which shouldn't block server boot.
threading.Thread(target=knowledge_base.ensure_builtin_seed_documents, daemon=True).start()


def get_setting(key, default=None):
    conn = sqlite3.connect(APP_DB_PATH)
    row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    conn.close()
    return row[0] if row else default


def set_setting(key, value):
    conn = sqlite3.connect(APP_DB_PATH)
    conn.execute("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", (key, value))
    conn.commit()
    conn.close()


class RepoEntry(BaseModel):
    name: str | None = None
    source: str             # "local" | "git_url" — "local" also covers UNC/network paths, just a filesystem path
    value: str               # a filesystem path (local or \\server\share\...), or a git URL
    code_lang: str = "auto"  # "auto" | "python" | "dotnet" | "typescript"


class DbEntry(BaseModel):
    name: str | None = None
    source: str              # "connection_string" | "sql_file" — sql_file path may be local or UNC
    value: str
    dialect: str = "auto"    # "auto" | "postgres" | "mysql" | "mssql" — only consulted for sql_file


class ExternalContextEntry(BaseModel):
    kind: str                # "jira" | "confluence"
    url: str


class AnalyzeRequest(BaseModel):
    repos: list[RepoEntry]
    databases: list[DbEntry] = []
    external_context: list[ExternalContextEntry] = []


def _rmtree_readonly_safe(path):
    """git marks objects/pack/*.idx and *.pack files read-only on Windows,
    and shutil.rmtree() doesn't clear that bit before trying to unlink them —
    it just raises PermissionError ([WinError 5] Access is denied) on any
    previously-cloned repo's .git directory. Clear the bit and retry once
    per failing path; a no-op on platforms where this was never an issue."""
    def _on_error(func, failed_path, exc_info):
        try:
            os.chmod(failed_path, stat.S_IWRITE)
            func(failed_path)
        except Exception:
            pass
    shutil.rmtree(path, onerror=_on_error)


def resolve_repo_path(source: str, value: str, slug: str) -> str:
    if source == "local":
        if not os.path.isdir(value):
            raise ValueError(f"Local path not found: {value}")
        return value
    # git_url
    dest = str(CLONE_DIR / slug)
    if os.path.isdir(dest):
        _rmtree_readonly_safe(dest)
    subprocess.run(["git", "clone", "--quiet", value, dest], check=True, timeout=600)
    return dest


def write_sqlite(files, tables, edges):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("DROP TABLE IF EXISTS code_metrics")
    cur.execute("""CREATE TABLE code_metrics (
        file TEXT PRIMARY KEY, loc INTEGER, sloc INTEGER, avg_complexity REAL,
        max_complexity REAL, maintainability_index REAL, function_count INTEGER,
        churn INTEGER, fan_in INTEGER, fan_out INTEGER,
        security_issue_count INTEGER, security_high_count INTEGER,
        debt_score REAL, updated_at TEXT)""")
    now = datetime.now(timezone.utc).isoformat()
    for f in files:
        cur.execute("INSERT INTO code_metrics VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                     (f["file"], f["loc"], f["sloc"], f["avg_complexity"], f["max_complexity"],
                      f["maintainability_index"], f["function_count"], f["churn"],
                      f["fan_in"], f["fan_out"], f["security_issue_count"], f["security_high_count"],
                      f["debt_score"], now))

    cur.execute("DROP TABLE IF EXISTS db_metrics")
    cur.execute("""CREATE TABLE db_metrics (
        table_name TEXT PRIMARY KEY, row_estimate INTEGER, size_bytes INTEGER,
        column_count INTEGER, fk_out INTEGER, fk_in INTEGER,
        missing_indexed_fks INTEGER, missing_primary_key INTEGER,
        high_risk_column_count INTEGER, public_write_grants INTEGER,
        debt_score REAL, updated_at TEXT)""")
    for t in tables:
        cur.execute("INSERT INTO db_metrics VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                     (t["file"], t["row_estimate"], t["size_bytes"], t["column_count"],
                      t["fk_out"], t["fk_in"], t["missing_indexed_fks"], int(t["missing_primary_key"]),
                      len(t["high_risk_columns"]), t["public_write_grants"], t["debt_score"], now))

    cur.execute("DROP TABLE IF EXISTS dependency_edges")
    cur.execute("CREATE TABLE dependency_edges (source TEXT, target TEXT, edge_type TEXT)")
    for e in edges:
        cur.execute("INSERT INTO dependency_edges VALUES (?,?,?)", (e["source"], e["target"], e.get("edge_type", "code_import")))
    conn.commit()
    conn.close()


def record_run_history(payload):
    """Appends one row to analysis_runs plus one row per file/table to
    node_debt_history — additive, never overwritten, so /api/trend can chart
    a node's (or the whole codebase's) debt score across every past run.
    Best-effort: a history-write failure should never fail the analysis that
    already succeeded and is already on disk in METRICS_PATH."""
    try:
        conn = sqlite3.connect(APP_DB_PATH)
        cur = conn.cursor()
        cur.execute(
            """INSERT INTO analysis_runs
               (generated_at, repo_label, total_files, total_tables, total_edges, avg_code_debt, avg_db_debt, high_debt_count)
               VALUES (?,?,?,?,?,?,?,?)""",
            (payload["generated_at"], payload["repo"], payload["summary"]["total_files"], payload["summary"]["total_tables"],
             payload["summary"]["total_edges"], payload["summary"]["avg_code_debt"], payload["summary"]["avg_db_debt"],
             payload["summary"]["high_debt_count"]),
        )
        run_id = cur.lastrowid
        rows = [(run_id, f["file"], "file", f["debt_score"]) for f in payload["files"]]
        rows += [(run_id, t["file"], "table", t["debt_score"]) for t in payload["tables"]]
        cur.executemany("INSERT INTO node_debt_history (run_id, node_id, kind, debt_score) VALUES (?,?,?,?)", rows)
        conn.commit()
        conn.close()
    except Exception:
        pass  # trend history is a nice-to-have overlay, never a reason to mark a completed analysis as failed


def run_analysis(req: AnalyzeRequest):
    global FILE_PATHS, SOURCE_TEXT, REPO_SLUGS, REPO_PATHS
    try:
        JOB.update(status="running", step="resolving repositories", error=None)

        repo_slugs_seen = set()
        repo_specs = []
        for entry in req.repos:
            slug = multi_source.slugify(entry.name or entry.value, repo_slugs_seen)
            path = resolve_repo_path(entry.source, entry.value, slug)
            repo_specs.append({
                "slug": slug, "path": path, "code_lang": entry.code_lang,
                "name": entry.name or os.path.basename(os.path.abspath(path)) or slug,
            })

        JOB["step"] = "analyzing code (complexity, churn, imports, duplication)"
        code_result = multi_source.analyze_repos(repo_specs)
        files = code_result["files"]
        code_edges = code_result["edges"]
        source_text = code_result["source_text"]
        FILE_PATHS = code_result["file_paths"]
        SOURCE_TEXT = source_text
        REPO_SLUGS = [r["slug"] for r in repo_specs]
        REPO_PATHS = {r["slug"]: r["path"] for r in repo_specs}
        code_langs = code_result["code_langs"]
        frameworks = code_result["frameworks"]

        JOB["step"] = "detecting implicit runtime coupling (shared caches/queues/services)"
        coupling_edges = coupling_analyzer.detect_coupling(source_text)

        db_slugs_seen = set()
        db_specs = []
        for entry in req.databases:
            slug = multi_source.slugify(entry.name or entry.value, db_slugs_seen)
            db_specs.append({
                "slug": slug, "source": entry.source, "value": entry.value,
                "dialect": entry.dialect, "name": entry.name or slug,
            })

        tables, db_edges, dialects = [], [], {}
        if db_specs:
            JOB["step"] = "introspecting databases"
            db_result = multi_source.analyze_databases(db_specs)
            tables, db_edges, dialects = db_result["tables"], db_result["edges"], db_result["dialects"]

        code_to_table_edges = []
        if tables:
            JOB["step"] = "linking code to data"
            # Code references the bare table name ("orders"), not the
            # namespaced id ("orders-db.orders") — match on bare names, then
            # expand back to every namespaced table that bare name maps to
            # (more than one DB source can have a same-named table; when
            # that happens we link to all of them rather than guess which).
            bare_to_namespaced = {}
            for t in tables:
                bare_to_namespaced.setdefault(t.get("bare_name", t["file"]), []).append(t["file"])
            raw_edges = db_analyzers.find_code_to_table_edges(source_text, list(bare_to_namespaced))
            for e in raw_edges:
                for target_id in bare_to_namespaced.get(e["target"], [e["target"]]):
                    code_to_table_edges.append({**e, "target": target_id})

        external_context_results = []
        if req.external_context:
            JOB["step"] = "fetching Jira/Confluence context"
            atlassian_email = get_setting("atlassian_email")
            atlassian_api_token = get_setting("atlassian_api_token")
            for ctx in req.external_context:
                external_context_results.append(
                    external_context.fetch_context(ctx.kind, ctx.url, atlassian_email, atlassian_api_token)
                )

        all_nodes = files + tables
        all_edges = code_edges + db_edges + code_to_table_edges + coupling_edges

        JOB["step"] = "writing results"
        write_sqlite(files, tables, all_edges)

        repo_names = [r["name"] for r in repo_specs]
        payload = {
            "repo": " + ".join(repo_names),
            "repos": [
                {
                    "slug": r["slug"], "name": r["name"],
                    "code_langs": code_langs.get(r["slug"], [r["code_lang"]]),
                    "frameworks": frameworks.get(r["slug"], {}),
                }
                for r in repo_specs
            ],
            "databases": [
                {"slug": d["slug"], "name": d["name"], "dialect": dialects.get(d["slug"], d["dialect"])}
                for d in db_specs
            ],
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "has_db": bool(tables),
            # kept for a single repo/db so existing single-source displays are unchanged;
            # empty/None when there's more than one — see the "repos"/"databases" lists instead.
            # A repo can itself be more than one language (e.g. .NET + a JS/TS frontend
            # folder), so this is a list even in the single-repo case.
            "code_langs": code_langs.get(repo_specs[0]["slug"], []) if len(repo_specs) == 1 else [],
            "frameworks": frameworks.get(repo_specs[0]["slug"], {}) if len(repo_specs) == 1 else {},
            "db_dialect": dialects.get(db_specs[0]["slug"]) if len(db_specs) == 1 else None,
            "external_context": external_context_results,
            "summary": {
                "total_files": len(files),
                "total_tables": len(tables),
                "total_edges": len(all_edges),
                "avg_code_debt": round(sum(f["debt_score"] for f in files) / len(files), 4) if files else 0,
                "avg_db_debt": round(sum(t["debt_score"] for t in tables) / len(tables), 4) if tables else 0,
                "high_debt_count": sum(1 for n in all_nodes if n["debt_score"] >= 0.6),
            },
            "files": files,
            "tables": tables,
            "edges": all_edges,
        }
        with open(METRICS_PATH, "w") as fh:
            json.dump(payload, fh)
        record_run_history(payload)
        JOB.update(status="done", step="complete")
    except Exception as e:
        JOB.update(status="error", error=str(e))


@app.post("/api/analyze")
def analyze(req: AnalyzeRequest):
    if JOB["status"] == "running":
        return {"ok": False, "message": "An analysis is already running."}
    t = threading.Thread(target=run_analysis, args=(req,), daemon=True)
    t.start()
    return {"ok": True}


@app.get("/api/status")
def status():
    return JOB


@app.get("/api/metrics")
def metrics():
    if not METRICS_PATH.exists():
        return {"ready": False}
    with open(METRICS_PATH) as fh:
        data = json.load(fh)
    data["ready"] = True
    return data


FILE_SOURCE_MAX_CHARS = 60_000


@app.get("/api/file-source")
def file_source(id: str):
    """Serves real source for the source-grounded 'Get recommendations' flow.
    `id` is only ever looked up against FILE_PATHS — a map this server built
    itself during the last analysis — never treated as a filesystem path, so
    there's no path-traversal surface no matter what a caller sends."""
    path = FILE_PATHS.get(id)
    if not path or not os.path.isfile(path):
        return {"ok": False, "error": "Source not available for this file (re-run analysis if the repo changed)."}
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as fh:
            text = fh.read(FILE_SOURCE_MAX_CHARS + 1)
    except Exception as e:
        return {"ok": False, "error": str(e)}
    return {"ok": True, "source": text[:FILE_SOURCE_MAX_CHARS], "truncated": len(text) > FILE_SOURCE_MAX_CHARS}


def _ingest_document_job(path, filename):
    try:
        knowledge_base.ingest_document(path, filename)
    except Exception:
        pass  # ingest_document already records its own error onto the document row


@app.post("/api/knowledge/upload")
async def knowledge_upload(file: UploadFile = File(...)):
    doc_id = uuid.uuid4().hex[:12]
    safe_name = os.path.basename(file.filename or "document")
    dest = knowledge_base.KNOWLEDGE_DIR / f"{doc_id}__{safe_name}"
    with open(dest, "wb") as fh:
        fh.write(await file.read())
    t = threading.Thread(target=_ingest_document_job, args=(str(dest), safe_name), daemon=True)
    t.start()
    return {"ok": True, "filename": safe_name}


@app.get("/api/knowledge/documents")
def knowledge_documents():
    return {"documents": knowledge_base.list_documents()}


@app.delete("/api/knowledge/documents/{doc_id}")
def knowledge_delete_document(doc_id: str):
    deleted = knowledge_base.delete_document(doc_id)
    if not deleted:
        raise HTTPException(status_code=400, detail="This is a built-in reference document and can't be deleted.")
    return {"ok": True}


class KnowledgeSearchRequest(BaseModel):
    query: str
    top_k: int = 5


@app.post("/api/knowledge/search")
def knowledge_search(req: KnowledgeSearchRequest):
    return {"results": knowledge_base.search(req.query, top_k=req.top_k)}


class KnowledgeFeedbackRequest(BaseModel):
    chunk_id: str
    vote: str          # "up" | "down"
    query: str | None = None


@app.post("/api/knowledge/feedback")
def knowledge_feedback(req: KnowledgeFeedbackRequest):
    knowledge_base.record_feedback(req.chunk_id, req.vote, req.query)
    return {"ok": True}


class ChatRequest(BaseModel):
    system: str
    messages: list
    max_tokens: int = 500


@app.post("/api/chat")
def chat(req: ChatRequest):
    provider = get_setting("active_provider", "anthropic")
    model = get_setting(f"{provider}_model", llm_providers.PROVIDERS[provider]["default_model"])
    api_key = get_setting(f"{provider}_api_key")
    if not api_key and provider == "anthropic":
        api_key = os.environ.get("ANTHROPIC_API_KEY") or HARDCODED_ANTHROPIC_API_KEY
    base_url = get_setting("ollama_base_url", llm_providers.DEFAULT_OLLAMA_BASE_URL) if provider == "ollama" else None
    try:
        text = llm_providers.call_llm(provider, model, api_key, req.system, req.messages, req.max_tokens, base_url=base_url)
        return {"content": [{"type": "text", "text": text}]}
    except Exception as e:
        return {"content": [{"type": "text", "text": f"[{provider} error] {e}"}], "error": True}


class SettingsRequest(BaseModel):
    active_provider: str | None = None
    anthropic_model: str | None = None
    gemini_model: str | None = None
    ollama_model: str | None = None
    anthropic_api_key: str | None = None   # empty string / None = leave unchanged
    gemini_api_key: str | None = None
    ollama_api_key: str | None = None      # never required — Ollama ignores it
    ollama_base_url: str | None = None
    atlassian_email: str | None = None            # Jira + Confluence Cloud share one credential pair
    atlassian_api_token: str | None = None
    github_token: str | None = None    # optional — raises PR-mining's API rate limit and unlocks private repos
    gitlab_token: str | None = None    # optional — same, for gitlab.com


def _mask(key):
    if not key:
        return ""
    return key[:6] + "…" + key[-4:] if len(key) > 12 else "•" * len(key)


@app.get("/api/settings")
def get_settings():
    out = {"active_provider": get_setting("active_provider", "anthropic"), "providers": {}}
    for p, meta in llm_providers.PROVIDERS.items():
        stored_key = get_setting(f"{p}_api_key", "")
        env_fallback = os.environ.get("ANTHROPIC_API_KEY") if p == "anthropic" else None
        # Ollama runs locally and never needs a key — always "ready" so its
        # card doesn't show a misleading "no key yet" warning.
        has_key = p == "ollama" or bool(stored_key) or bool(env_fallback) or (p == "anthropic" and HARDCODED_ANTHROPIC_API_KEY.startswith("sk-ant-") and "REPLACE" not in HARDCODED_ANTHROPIC_API_KEY)
        out["providers"][p] = {
            "label": meta["label"],
            "model": get_setting(f"{p}_model", meta["default_model"]),
            "has_key": has_key,
            "key_preview": _mask(stored_key),
        }
        if p == "ollama":
            out["providers"][p]["base_url"] = get_setting("ollama_base_url", llm_providers.DEFAULT_OLLAMA_BASE_URL)
    stored_email = get_setting("atlassian_email", "")
    stored_token = get_setting("atlassian_api_token", "")
    out["atlassian"] = {
        "email": stored_email,
        "has_token": bool(stored_token),
        "token_preview": _mask(stored_token),
    }
    out["pr_mining"] = {
        "github_has_token": bool(get_setting("github_token", "")),
        "github_token_preview": _mask(get_setting("github_token", "")),
        "gitlab_has_token": bool(get_setting("gitlab_token", "")),
        "gitlab_token_preview": _mask(get_setting("gitlab_token", "")),
    }
    return out


@app.post("/api/settings")
def save_settings(req: SettingsRequest):
    if req.active_provider:
        set_setting("active_provider", req.active_provider)
    for provider in ("anthropic", "gemini", "ollama"):
        model = getattr(req, f"{provider}_model")
        if model:
            set_setting(f"{provider}_model", model)
        key = getattr(req, f"{provider}_api_key")
        if key:  # only overwrite if the user actually typed something
            set_setting(f"{provider}_api_key", key)
    if req.ollama_base_url:
        set_setting("ollama_base_url", req.ollama_base_url)
    if req.atlassian_email is not None:
        set_setting("atlassian_email", req.atlassian_email)
    if req.atlassian_api_token:  # only overwrite if the user actually typed something
        set_setting("atlassian_api_token", req.atlassian_api_token)
    if req.github_token:
        set_setting("github_token", req.github_token)
    if req.gitlab_token:
        set_setting("gitlab_token", req.gitlab_token)
    return {"ok": True}


class FeedbackRequest(BaseModel):
    question: str
    answer: str
    vote: str          # "up" | "down"
    node_id: str | None = None


@app.post("/api/feedback")
def submit_feedback(req: FeedbackRequest):
    conn = sqlite3.connect(APP_DB_PATH)
    conn.execute(
        "INSERT INTO chat_feedback (question, answer, vote, node_id, created_at) VALUES (?,?,?,?,?)",
        (req.question, req.answer, req.vote, req.node_id, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()
    conn.close()
    return {"ok": True}


@app.get("/api/feedback/recent")
def recent_feedback(vote: str = "down", limit: int = 5, scope: str = "chat"):
    # "chat" (Ask tab answers, node_id is never set) and "recommendation"
    # (per-file/table recommendations, node_id is always set) are kept as
    # separate in-context conditioning loops since they answer structurally
    # different questions — a down-voted chat answer isn't a useful example
    # of what to avoid in a file recommendation, and vice versa.
    node_id_clause = "node_id IS NOT NULL" if scope == "recommendation" else "node_id IS NULL"
    conn = sqlite3.connect(APP_DB_PATH)
    rows = conn.execute(
        f"SELECT question, answer, created_at FROM chat_feedback WHERE vote = ? AND {node_id_clause} ORDER BY id DESC LIMIT ?",
        (vote, limit),
    ).fetchall()
    conn.close()
    return {"items": [{"question": q, "answer": a, "created_at": c} for q, a, c in rows]}


@app.get("/api/feedback/stats")
def feedback_stats():
    conn = sqlite3.connect(APP_DB_PATH)
    up = conn.execute("SELECT COUNT(*) FROM chat_feedback WHERE vote='up'").fetchone()[0]
    down = conn.execute("SELECT COUNT(*) FROM chat_feedback WHERE vote='down'").fetchone()[0]
    conn.close()
    return {"up": up, "down": down}


def _load_current_metrics():
    if not METRICS_PATH.exists():
        return None
    with open(METRICS_PATH) as fh:
        return json.load(fh)


def _nodes_by_id(data):
    return {n["file"]: n for n in data.get("files", []) + data.get("tables", [])}


# --- Blast radius (change-impact queries) ---------------------------------

@app.get("/api/blast-radius")
def blast_radius(node_id: str, direction: str = "both", max_depth: int = 3):
    data = _load_current_metrics()
    if not data:
        return {"ok": False, "error": "No analysis has been run yet."}
    if direction not in ("upstream", "downstream", "both"):
        raise HTTPException(status_code=400, detail="direction must be 'upstream', 'downstream', or 'both'")
    max_depth = max(1, min(max_depth, 10))
    result = graph_queries.blast_radius(node_id, data.get("edges", []), direction=direction, max_depth=max_depth)
    graph_queries.enrich_with_node_data(result, _nodes_by_id(data))
    return {"ok": True, **result}


# --- Trend history across analysis runs ------------------------------------

@app.get("/api/runs")
def list_runs(limit: int = 50):
    conn = sqlite3.connect(APP_DB_PATH)
    rows = conn.execute(
        """SELECT run_id, generated_at, repo_label, total_files, total_tables, total_edges,
                  avg_code_debt, avg_db_debt, high_debt_count
           FROM analysis_runs ORDER BY run_id DESC LIMIT ?""",
        (limit,),
    ).fetchall()
    conn.close()
    cols = ["run_id", "generated_at", "repo_label", "total_files", "total_tables", "total_edges", "avg_code_debt", "avg_db_debt", "high_debt_count"]
    return {"runs": [dict(zip(cols, r)) for r in reversed(rows)]}  # oldest-first, ready to feed straight into a chart


@app.get("/api/trend")
def node_trend(node_id: str, limit: int = 50):
    conn = sqlite3.connect(APP_DB_PATH)
    rows = conn.execute(
        """SELECT ar.run_id, ar.generated_at, h.debt_score
           FROM node_debt_history h JOIN analysis_runs ar ON ar.run_id = h.run_id
           WHERE h.node_id = ? ORDER BY ar.run_id DESC LIMIT ?""",
        (node_id, limit),
    ).fetchall()
    conn.close()
    points = [{"run_id": r[0], "generated_at": r[1], "debt_score": r[2]} for r in reversed(rows)]
    return {"node_id": node_id, "points": points}


# --- PR-history mining -------------------------------------------------------

def _pr_mining_job(repo_slug, repo_path):
    PR_MINING_JOBS[repo_slug] = {"status": "running", "error": None}
    try:
        provider = get_setting("active_provider", "anthropic")
        model = get_setting(f"{provider}_model", llm_providers.PROVIDERS[provider]["default_model"])
        api_key = get_setting(f"{provider}_api_key")
        if not api_key and provider == "anthropic":
            api_key = os.environ.get("ANTHROPIC_API_KEY") or HARDCODED_ANTHROPIC_API_KEY
        base_url = get_setting("ollama_base_url", llm_providers.DEFAULT_OLLAMA_BASE_URL) if provider == "ollama" else None
        remote = pr_context.detect_remote(repo_path)
        token = None
        if remote:
            token = get_setting(f"{remote['host']}_token")  # optional — set via Admin panel; raises the API rate limit and unlocks private repos
        result = pr_context.mine_repo(repo_path, provider, model, api_key, base_url=base_url, token=token)
        if not result.get("ok"):
            PR_MINING_JOBS[repo_slug] = {"status": "error", "error": result.get("error")}
            return
        conn = sqlite3.connect(APP_DB_PATH)
        now = datetime.now(timezone.utc).isoformat()
        conn.executemany(
            "INSERT INTO pr_insights (repo_slug, file_hint, insight, source_pr, created_at) VALUES (?,?,?,?,?)",
            [(repo_slug, ins["file"], ins["insight"], ins.get("source_pr"), now) for ins in result.get("insights", [])],
        )
        conn.commit()
        conn.close()
        PR_MINING_JOBS[repo_slug] = {"status": "done", "error": None}
    except Exception as e:
        PR_MINING_JOBS[repo_slug] = {"status": "error", "error": str(e)}


class MinePrRequest(BaseModel):
    repo_slug: str


@app.post("/api/pr-insights/mine")
def mine_pr_insights(req: MinePrRequest):
    repo_path = REPO_PATHS.get(req.repo_slug)
    if not repo_path:
        return {"ok": False, "error": "Unknown repo slug (re-run analysis first — repo paths aren't kept across a server restart)."}
    if PR_MINING_JOBS.get(req.repo_slug, {}).get("status") == "running":
        return {"ok": False, "error": "PR mining is already running for this repo."}
    t = threading.Thread(target=_pr_mining_job, args=(req.repo_slug, repo_path), daemon=True)
    t.start()
    return {"ok": True}


@app.get("/api/pr-insights/status")
def pr_insights_status(repo_slug: str):
    return PR_MINING_JOBS.get(repo_slug, {"status": "idle", "error": None})


@app.get("/api/pr-insights")
def pr_insights(file_id: str = None, repo_slug: str = None):
    conn = sqlite3.connect(APP_DB_PATH)
    if repo_slug:
        rows = conn.execute(
            "SELECT id, repo_slug, file_hint, insight, source_pr, created_at FROM pr_insights WHERE repo_slug = ? ORDER BY id DESC",
            (repo_slug,),
        ).fetchall()
    else:
        rows = conn.execute("SELECT id, repo_slug, file_hint, insight, source_pr, created_at FROM pr_insights ORDER BY id DESC").fetchall()
    conn.close()
    cols = ["id", "repo_slug", "file_hint", "insight", "source_pr", "created_at"]
    items = [dict(zip(cols, r)) for r in rows]
    if file_id:
        # a PR's file path ("backend/app.py") won't exactly equal our namespaced
        # file id ("myrepo/backend/app.py") — match on suffix in either direction
        items = [it for it in items if it["file_hint"] and (file_id.endswith(it["file_hint"]) or it["file_hint"].endswith(file_id.split("/", 1)[-1]))]
    return {"items": items}


# --- AI module/architecture narratives ---------------------------------------

@app.get("/api/modules")
def list_modules():
    data = _load_current_metrics()
    if not data:
        return {"ok": False, "error": "No analysis has been run yet."}
    modules = module_narrative.group_into_modules(data.get("files", []), REPO_SLUGS or [r["slug"] for r in data.get("repos", [])])
    conn = sqlite3.connect(APP_DB_PATH)
    cached = {row[0]: row for row in conn.execute("SELECT module_id, content_hash, narrative_json, status, error, generated_at FROM module_narratives")}
    conn.close()
    out = []
    for module_id, file_list in modules.items():
        summary = module_narrative.build_module_summary(module_id, file_list)
        row = cached.get(module_id)
        entry = {**summary, "narrative": None, "narrative_status": "not_generated", "narrative_stale": False, "narrative_error": None}
        if row:
            _, cached_hash, narrative_json, status, error, generated_at = row
            entry["narrative"] = json.loads(narrative_json) if narrative_json else None
            entry["narrative_status"] = status
            entry["narrative_error"] = error
            entry["narrative_stale"] = cached_hash != summary["content_hash"]
            entry["generated_at"] = generated_at
        out.append(entry)
    out.sort(key=lambda m: m["avg_debt"], reverse=True)
    return {"modules": out}


def _generate_module_job(module_id, file_list, summary):
    conn = sqlite3.connect(APP_DB_PATH)
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """INSERT INTO module_narratives (module_id, content_hash, summary_json, narrative_json, status, error, generated_at)
           VALUES (?,?,?,?,?,?,?)
           ON CONFLICT(module_id) DO UPDATE SET content_hash=excluded.content_hash, summary_json=excluded.summary_json,
               status=excluded.status, error=excluded.error, generated_at=excluded.generated_at""",
        (module_id, summary["content_hash"], json.dumps(summary), None, "running", None, now),
    )
    conn.commit()
    conn.close()

    provider = get_setting("active_provider", "anthropic")
    model = get_setting(f"{provider}_model", llm_providers.PROVIDERS[provider]["default_model"])
    api_key = get_setting(f"{provider}_api_key")
    if not api_key and provider == "anthropic":
        api_key = os.environ.get("ANTHROPIC_API_KEY") or HARDCODED_ANTHROPIC_API_KEY
    base_url = get_setting("ollama_base_url", llm_providers.DEFAULT_OLLAMA_BASE_URL) if provider == "ollama" else None

    result = module_narrative.generate_narrative(module_id, file_list, SOURCE_TEXT, provider, model, api_key, base_url=base_url)
    conn = sqlite3.connect(APP_DB_PATH)
    if result["ok"]:
        conn.execute(
            "UPDATE module_narratives SET narrative_json = ?, status = 'done', error = NULL WHERE module_id = ?",
            (json.dumps(result["narrative"]), module_id),
        )
    else:
        conn.execute("UPDATE module_narratives SET status = 'error', error = ? WHERE module_id = ?", (result["error"], module_id))
    conn.commit()
    conn.close()


class GenerateModuleRequest(BaseModel):
    module_id: str


@app.post("/api/modules/generate")
def generate_module(req: GenerateModuleRequest):
    data = _load_current_metrics()
    if not data:
        return {"ok": False, "error": "No analysis has been run yet."}
    modules = module_narrative.group_into_modules(data.get("files", []), REPO_SLUGS or [r["slug"] for r in data.get("repos", [])])
    file_list = modules.get(req.module_id)
    if not file_list:
        return {"ok": False, "error": "Unknown module id (re-run analysis if the codebase changed)."}
    summary = module_narrative.build_module_summary(req.module_id, file_list)
    t = threading.Thread(target=_generate_module_job, args=(req.module_id, file_list, summary), daemon=True)
    t.start()
    return {"ok": True}


# --- Graph annotations (MCP write tool -> human approval queue) -------------

@app.get("/api/annotations")
def list_annotations(status: str = "pending"):
    conn = sqlite3.connect(APP_DB_PATH)
    if status == "all":
        rows = conn.execute("SELECT id, node_id, note, author, status, created_at, decided_at FROM graph_annotations ORDER BY id DESC").fetchall()
    else:
        rows = conn.execute(
            "SELECT id, node_id, note, author, status, created_at, decided_at FROM graph_annotations WHERE status = ? ORDER BY id DESC",
            (status,),
        ).fetchall()
    conn.close()
    cols = ["id", "node_id", "note", "author", "status", "created_at", "decided_at"]
    return {"items": [dict(zip(cols, r)) for r in rows]}


@app.post("/api/annotations/{annotation_id}/approve")
def approve_annotation(annotation_id: int):
    conn = sqlite3.connect(APP_DB_PATH)
    conn.execute("UPDATE graph_annotations SET status = 'approved', decided_at = ? WHERE id = ?", (datetime.now(timezone.utc).isoformat(), annotation_id))
    conn.commit()
    conn.close()
    return {"ok": True}


@app.post("/api/annotations/{annotation_id}/reject")
def reject_annotation(annotation_id: int):
    conn = sqlite3.connect(APP_DB_PATH)
    conn.execute("UPDATE graph_annotations SET status = 'rejected', decided_at = ? WHERE id = ?", (datetime.now(timezone.utc).isoformat(), annotation_id))
    conn.commit()
    conn.close()
    return {"ok": True}


# --- serve the built frontend (npm run build -> ../frontend/dist) ---
STATIC_DIR = BASE_DIR / "static"
if STATIC_DIR.exists():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        return FileResponse(STATIC_DIR / "index.html")


if __name__ == "__main__":
    import uvicorn
    print("Tech Debt Radar running at http://localhost:8000")
    uvicorn.run(app, host="0.0.0.0", port=8000)
