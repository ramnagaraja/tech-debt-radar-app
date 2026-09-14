"""
Tech Debt Radar — MCP server.

Exposes the results of the last analysis run (and a few live queries over
them) to any MCP-speaking agent — Claude Code, Cursor, Claude Desktop, etc.
— so "what's the debt situation in the billing module" or "what would
touching this file put at risk" can be answered from inside an editor,
without a human first opening the web dashboard.

By design this reads directly from the on-disk analysis artifacts
(app_data/dashboard_data.json, app_data/debt_radar.db, app_data/app.db)
rather than calling the FastAPI server over HTTP — an agent can ask
questions here even if the web app isn't currently running, and this
process never needs to share a port or a process with it. The tradeoff:
these tools only ever see the *last completed* analysis, and one write
tool (annotate_node) only ever proposes a note for a human to accept or
reject in the web app's Admin panel — this server has no path to change a
debt score, edit a file, or touch the analyzed repo itself. That mirrors
this app's whole "you're always looking at real, re-derivable numbers"
design, on purpose.

Run:
    pip install -r requirements.txt
    python3 mcp_server.py

Point an MCP client at it over stdio. Example Claude Code / Claude Desktop
config entry:
    {
      "mcpServers": {
        "tech-debt-radar": {
          "command": "python3",
          "args": ["/absolute/path/to/backend/mcp_server.py"]
        }
      }
    }
"""
import json
import os
import sqlite3
from pathlib import Path

from mcp.server.mcpserver import MCPServer

import graph_queries
import llm_providers
import module_narrative

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "app_data"
METRICS_PATH = DATA_DIR / "dashboard_data.json"
APP_DB_PATH = DATA_DIR / "app.db"

HARDCODED_ANTHROPIC_API_KEY = "sk-ant-REPLACE-WITH-YOUR-KEY"  # kept in sync with app.py's own fallback

mcp = MCPServer(
    "tech-debt-radar",
    instructions=(
        "Query results from the last Tech Debt Radar analysis run: overall debt "
        "summary, per-module architecture narratives, per-file/table metrics, "
        "dependency and change-impact (blast-radius) queries, PR-history "
        "insights, and a grounded Q&A tool. One write tool (annotate_node) "
        "proposes a note for a human to approve in the web app — nothing here "
        "changes a debt score or the analyzed code."
    ),
)


def _load_metrics():
    if not METRICS_PATH.exists():
        return None
    with open(METRICS_PATH) as fh:
        return json.load(fh)


def _nodes_by_id(data):
    return {n["file"]: n for n in data.get("files", []) + data.get("tables", [])}


def _app_db():
    return sqlite3.connect(APP_DB_PATH)


def _get_setting(key, default=None):
    if not APP_DB_PATH.exists():
        return default
    conn = _app_db()
    row = conn.execute("SELECT value FROM app_settings WHERE key = ?", (key,)).fetchone()
    conn.close()
    return row[0] if row else default


def _resolve_llm_config():
    provider = _get_setting("active_provider", "anthropic")
    model = _get_setting(f"{provider}_model", llm_providers.PROVIDERS[provider]["default_model"])
    api_key = _get_setting(f"{provider}_api_key")
    if not api_key and provider == "anthropic":
        api_key = os.environ.get("ANTHROPIC_API_KEY") or HARDCODED_ANTHROPIC_API_KEY
    base_url = _get_setting("ollama_base_url", llm_providers.DEFAULT_OLLAMA_BASE_URL) if provider == "ollama" else None
    return provider, model, api_key, base_url


@mcp.tool()
def get_project_overview() -> dict:
    """Overall summary of the last completed analysis run: repo/DB names,
    languages and frameworks detected, and the top-level debt summary
    (file/table counts, average code and DB debt, how many nodes are
    high-debt). Call this first to orient before drilling into a module or
    file — it also tells you whether an analysis has ever been run."""
    data = _load_metrics()
    if not data:
        return {"ok": False, "error": "No analysis has been run yet — run one from the Tech Debt Radar web app first."}
    return {
        "ok": True,
        "repo": data.get("repo"),
        "repos": data.get("repos"),
        "databases": data.get("databases"),
        "generated_at": data.get("generated_at"),
        "summary": data.get("summary"),
    }


@mcp.tool()
def get_module_info(module_id: str) -> dict:
    """Aggregated metrics and (if generated in the web app) the AI-authored
    architecture narrative for one module — a top-level-ish folder grouping
    of files, e.g. "backend/api" or "frontend/src/components". Use
    get_project_overview or a blank module_id call first if you don't know
    valid module ids; this tool lists all of them when module_id is empty."""
    data = _load_metrics()
    if not data:
        return {"ok": False, "error": "No analysis has been run yet."}
    repo_slugs = [r["slug"] for r in data.get("repos", [])]
    modules = module_narrative.group_into_modules(data.get("files", []), repo_slugs)

    if not module_id:
        return {"ok": True, "module_ids": sorted(modules.keys())}

    file_list = modules.get(module_id)
    if not file_list:
        return {"ok": False, "error": f"Unknown module id {module_id!r}.", "module_ids": sorted(modules.keys())}

    summary = module_narrative.build_module_summary(module_id, file_list)
    narrative = None
    if APP_DB_PATH.exists():
        conn = _app_db()
        row = conn.execute("SELECT narrative_json, status, error FROM module_narratives WHERE module_id = ?", (module_id,)).fetchone()
        conn.close()
        if row and row[0]:
            narrative = json.loads(row[0])
    return {"ok": True, **summary, "narrative": narrative}


@mcp.tool()
def get_file(file_id: str) -> dict:
    """Full metrics for one analyzed file or database table (complexity,
    churn, fan-in/out, security-issue counts, debt score and its breakdown)
    — the same numbers the web dashboard shows for that node. `file_id` is
    the id shown by get_project_overview/get_module_info, e.g.
    "backend/app.py". Raw source text is not exposed here — open the file in
    your editor for that; this tool is for the computed metrics."""
    data = _load_metrics()
    if not data:
        return {"ok": False, "error": "No analysis has been run yet."}
    node = _nodes_by_id(data).get(file_id)
    if not node:
        return {"ok": False, "error": f"No file or table with id {file_id!r} in the last analysis run."}
    return {"ok": True, "node": node}


@mcp.tool()
def get_dependencies(file_id: str) -> dict:
    """One-hop dependency info for a file/table: what it directly imports or
    references (fan-out), and what directly imports or references it
    (fan-in) — including implicit runtime couplings (shared Redis keys,
    Kafka topics, queues) when the analysis detected any. For anything
    beyond one hop, use get_blast_radius instead."""
    data = _load_metrics()
    if not data:
        return {"ok": False, "error": "No analysis has been run yet."}
    out_adj, in_adj = graph_queries.build_adjacency(data.get("edges", []))
    return {
        "ok": True,
        "file_id": file_id,
        "depends_on": [{"id": t, "edge_type": et} for t, et in out_adj.get(file_id, [])],
        "depended_on_by": [{"id": s, "edge_type": et} for s, et in in_adj.get(file_id, [])],
    }


@mcp.tool()
def get_blast_radius(file_id: str, direction: str = "both", max_depth: int = 3) -> dict:
    """Change-impact analysis: starting from one file or table, walks the
    dependency graph outward up to max_depth hops and reports everything
    reachable, tagged with how many hops away it is and whether it's
    "upstream" (this node's own dependencies — what it's exposed to) or
    "downstream" (what depends on it — what could break if you change it).
    Use direction="downstream" for the question "what am I about to break if
    I change this file", "upstream" for "what does this file rely on", or
    "both" (default) for the full picture. This is the tool to reach for
    before a refactor of anything that looks central."""
    data = _load_metrics()
    if not data:
        return {"ok": False, "error": "No analysis has been run yet."}
    if direction not in ("upstream", "downstream", "both"):
        return {"ok": False, "error": "direction must be 'upstream', 'downstream', or 'both'."}
    max_depth = max(1, min(max_depth, 10))
    result = graph_queries.blast_radius(file_id, data.get("edges", []), direction=direction, max_depth=max_depth)
    graph_queries.enrich_with_node_data(result, _nodes_by_id(data))
    return {"ok": True, **result}


@mcp.tool()
def get_pr_insights(file_id: str = "") -> dict:
    """Durable "gotchas" mined from this repo's merged pull-request history —
    invariants, migration steps, footguns a past PR called out — for a given
    file (leave file_id empty to get every insight on record, across all
    files). Empty results usually mean PR mining hasn't been run yet for
    this repo (triggered from the web app's Admin panel, or POST
    /api/pr-insights/mine), not that the file has no history."""
    if not APP_DB_PATH.exists():
        return {"ok": True, "items": []}
    conn = _app_db()
    rows = conn.execute("SELECT id, repo_slug, file_hint, insight, source_pr, created_at FROM pr_insights ORDER BY id DESC").fetchall()
    conn.close()
    cols = ["id", "repo_slug", "file_hint", "insight", "source_pr", "created_at"]
    items = [dict(zip(cols, r)) for r in rows]
    if file_id:
        items = [it for it in items if it["file_hint"] and (file_id.endswith(it["file_hint"]) or it["file_hint"].endswith(file_id.split("/", 1)[-1]))]
    return {"ok": True, "items": items}


@mcp.tool()
def ask_codebase(question: str) -> dict:
    """Ask a free-form question about the analyzed codebase's debt, grounded
    in the last analysis run's summary and its highest-debt files/tables.
    Uses whichever LLM provider is configured in the web app's Admin panel.
    Good for "what are the riskiest files to touch right now" or "summarize
    the database debt situation" — for anything needing exact numbers on a
    specific file, prefer get_file or get_blast_radius, which are grounded
    in the real metrics rather than a model's summary of them."""
    data = _load_metrics()
    if not data:
        return {"ok": False, "error": "No analysis has been run yet."}
    all_nodes = data.get("files", []) + data.get("tables", [])
    top_debt = sorted(all_nodes, key=lambda n: n.get("debt_score", 0) or 0, reverse=True)[:15]
    context_lines = [f"- {n['file']} (debt {n.get('debt_score', 0):.2f})" for n in top_debt]
    system = (
        "You are answering a question about a codebase's technical debt, based only "
        "on the summary and highest-debt-file list given below. Be concise and specific. "
        "If the question needs information not present here, say what's missing rather "
        "than guessing.\n\n"
        f"Summary: {json.dumps(data.get('summary', {}))}\n\n"
        f"Highest-debt files/tables:\n" + "\n".join(context_lines)
    )
    provider, model, api_key, base_url = _resolve_llm_config()
    try:
        answer = llm_providers.call_llm(provider, model, api_key, system, [{"role": "user", "content": question}], max_tokens=800, base_url=base_url)
        return {"ok": True, "answer": answer}
    except Exception as e:
        return {"ok": False, "error": f"[{provider} error] {e}"}


@mcp.tool()
def list_pending_annotations() -> dict:
    """Lists graph annotations awaiting human approval in the web app's Admin
    panel — useful to check the status of a note you proposed with
    annotate_node before assuming it's been accepted."""
    if not APP_DB_PATH.exists():
        return {"ok": True, "items": []}
    conn = _app_db()
    rows = conn.execute(
        "SELECT id, node_id, note, author, status, created_at FROM graph_annotations WHERE status = 'pending' ORDER BY id DESC"
    ).fetchall()
    conn.close()
    cols = ["id", "node_id", "note", "author", "status", "created_at"]
    return {"ok": True, "items": [dict(zip(cols, r)) for r in rows]}


@mcp.tool()
def annotate_node(file_id: str, note: str, author: str = "mcp-agent") -> dict:
    """Proposes a note on a file or table — e.g. a fact static analysis
    couldn't see ("this has a hidden runtime dependency on env var X"). This
    ONLY inserts a pending row; it never changes a debt score, edge, or the
    analyzed code itself, and the note has no effect anywhere until a human
    approves it from the web app's Admin panel (Pending Annotations). Use
    this when you've learned something about a file during your own work
    that the next person (human or agent) to touch it should know."""
    if not note.strip():
        return {"ok": False, "error": "note must not be empty."}
    conn = _app_db()
    conn.execute("CREATE TABLE IF NOT EXISTS graph_annotations (id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT, note TEXT, author TEXT, status TEXT DEFAULT 'pending', created_at TEXT, decided_at TEXT)")
    import datetime as _dt
    now = _dt.datetime.now(_dt.timezone.utc).isoformat()
    cur = conn.execute(
        "INSERT INTO graph_annotations (node_id, note, author, status, created_at) VALUES (?,?,?,?,?)",
        (file_id, note.strip(), author, "pending", now),
    )
    conn.commit()
    annotation_id = cur.lastrowid
    conn.close()
    return {"ok": True, "annotation_id": annotation_id, "status": "pending", "message": "Recorded — a human must approve this from the web app's Admin panel before it's considered accepted."}


if __name__ == "__main__":
    mcp.run(transport="stdio")
