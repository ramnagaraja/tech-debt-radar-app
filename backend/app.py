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

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel

import code_analyzers
import db_analyzers
import llm_providers

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


class AnalyzeRequest(BaseModel):
    repo_source: str        # "local" | "git_url"
    repo_value: str         # a filesystem path, or a git URL
    db_source: str | None = None   # "connection_string" | "sql_file" | None
    db_value: str | None = None
    repo_name: str | None = None
    code_lang: str = "auto"        # "auto" | "python" | "dotnet"
    db_dialect: str = "auto"       # "auto" | "postgres" | "mysql" | "mssql" — only used for db_source == "sql_file"


def resolve_repo_path(req: AnalyzeRequest) -> str:
    if req.repo_source == "local":
        if not os.path.isdir(req.repo_value):
            raise ValueError(f"Local path not found: {req.repo_value}")
        return req.repo_value
    # git_url
    name = req.repo_name or f"repo-{uuid.uuid4().hex[:8]}"
    dest = str(CLONE_DIR / name)
    if os.path.isdir(dest):
        shutil.rmtree(dest)
    subprocess.run(["git", "clone", "--quiet", req.repo_value, dest], check=True, timeout=600)
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
    try:
        JOB.update(status="running", step="resolving repository", error=None)
        repo_path = resolve_repo_path(req)

        JOB["step"] = "analyzing code (complexity, churn, imports)"
        code_result = code_analyzers.analyze_codebase(repo_path, lang=req.code_lang)
        files, code_edges, source_text = code_result["files"], code_result["edges"], code_result["_source_text"]
        resolved_code_lang = code_result["_code_lang"]

        tables, db_edges, code_to_table_edges = [], [], []
        resolved_db_dialect = None
        if req.db_source == "connection_string" and req.db_value:
            JOB["step"] = "introspecting live database"
            db_result = db_analyzers.analyze_live_db(req.db_value)
            tables, db_edges = db_result["tables"], db_result["edges"]
            resolved_db_dialect = db_analyzers.detect_dialect_label(req.db_value)
        elif req.db_source == "sql_file" and req.db_value:
            JOB["step"] = "parsing SQL schema file"
            db_result = db_analyzers.analyze_sql_file(req.db_value, dialect=req.db_dialect)
            tables, db_edges = db_result["tables"], db_result["edges"]
            resolved_db_dialect = req.db_dialect

        if tables:
            JOB["step"] = "linking code to data"
            table_names = [t["file"] for t in tables]
            code_to_table_edges = db_analyzers.find_code_to_table_edges(source_text, table_names)

        all_nodes = files + tables
        all_edges = code_edges + db_edges + code_to_table_edges

        JOB["step"] = "writing results"
        write_sqlite(files, tables, all_edges)

        payload = {
            "repo": req.repo_name or os.path.basename(os.path.abspath(repo_path)),
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "has_db": bool(tables),
            "code_lang": resolved_code_lang,
            "db_dialect": resolved_db_dialect,
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
    try:
        text = llm_providers.call_llm(provider, model, api_key, req.system, req.messages, req.max_tokens)
        return {"content": [{"type": "text", "text": text}]}
    except Exception as e:
        return {"content": [{"type": "text", "text": f"[{provider} error] {e}"}], "error": True}


class SettingsRequest(BaseModel):
    active_provider: str | None = None
    anthropic_model: str | None = None
    gemini_model: str | None = None
    sarvam_model: str | None = None
    anthropic_api_key: str | None = None   # empty string / None = leave unchanged
    gemini_api_key: str | None = None
    sarvam_api_key: str | None = None


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
        has_key = bool(stored_key) or bool(env_fallback) or (p == "anthropic" and HARDCODED_ANTHROPIC_API_KEY.startswith("sk-ant-") and "REPLACE" not in HARDCODED_ANTHROPIC_API_KEY)
        out["providers"][p] = {
            "label": meta["label"],
            "model": get_setting(f"{p}_model", meta["default_model"]),
            "has_key": has_key,
            "key_preview": _mask(stored_key),
        }
    return out


@app.post("/api/settings")
def save_settings(req: SettingsRequest):
    if req.active_provider:
        set_setting("active_provider", req.active_provider)
    for provider in ("anthropic", "gemini", "sarvam"):
        model = getattr(req, f"{provider}_model")
        if model:
            set_setting(f"{provider}_model", model)
        key = getattr(req, f"{provider}_api_key")
        if key:  # only overwrite if the user actually typed something
            set_setting(f"{provider}_api_key", key)
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
def recent_feedback(vote: str = "down", limit: int = 5):
    conn = sqlite3.connect(APP_DB_PATH)
    rows = conn.execute(
        "SELECT question, answer, created_at FROM chat_feedback WHERE vote = ? ORDER BY id DESC LIMIT ?",
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
