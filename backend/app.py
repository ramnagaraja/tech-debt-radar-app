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
import db_analyzers
import external_context
import knowledge_base
import llm_providers
import multi_source

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
FILE_PATHS = {}  # {namespaced_file_id: absolute_path}, rebuilt on every analysis — backs /api/file-source


def init_app_db():
    conn = sqlite3.connect(APP_DB_PATH)
    cur = conn.cursor()
    cur.execute("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)")
    cur.execute("""CREATE TABLE IF NOT EXISTS chat_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT, answer TEXT,
        vote TEXT, node_id TEXT, created_at TEXT)""")
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


def run_analysis(req: AnalyzeRequest):
    global FILE_PATHS
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
        code_langs = code_result["code_langs"]
        frameworks = code_result["frameworks"]

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
        all_edges = code_edges + db_edges + code_to_table_edges

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
