"""
Flow-level risk heuristics: concurrency/edge-case red flags and request-chain
complexity.

Two distinct things live here, both operating on data every analysis run
already produces (source_text, and the combined edges list) — no new
per-language analyzer needed, the same design principle behind
coupling_analyzer.py and module_narrative.py:

1. detect_concurrency_risks(source_text) — a static, language-agnostic
   pattern scan (same honest limits as coupling_analyzer.py: regex over raw
   text, not a real dataflow/type analysis) for four specific, well-known
   footguns:
     - shared mutable module-level state written from more than one
       function in the same file, with no lock/semaphore anywhere in sight
     - a retry loop wrapped around what looks like a mutating call (an
       insert/update/commit/POST/PUT/DELETE), with no idempotency-key/nonce
       nearby — a retried non-idempotent write is a classic double-charge/
       double-insert bug
     - an outbound network or subprocess call with no visible timeout —
       the single most common cause of a service silently hanging forever
     - a background thread/task/process alongside shared mutable state and
       no visible lock construction

   Every finding is a lead to check, not a certainty — a regex pass can't
   see that a lock lives in an imported helper, or that a call really is
   idempotent for domain reasons a human would know. This mirrors exactly
   how coupling_analyzer.py and the security scanners already document
   their own honest limits.

2. chain_complexity(edges, nodes_by_id) — for every database table, the
   shortest number of hops back to the nearest frontend-tier file (pure BFS
   over the existing edges list, via graph_queries.build_adjacency), so a
   request chain that's grown unusually deep (many intermediate services/
   modules between a button click and the table it touches) is visible as
   a number, not something you have to trace by eye in the graph.
"""
import re
from collections import deque

import graph_queries

# --- Concurrency / edge-case pattern scan ---------------------------------

# A module-level assignment target: `NAME = ...` at column 0 (not indented
# inside a function/class body), where NAME looks like a constant/global
# (this deliberately doesn't try to distinguish a real mutable container
# from an immutable one via static typing — a dict/list/set literal or a
# call that plausibly returns one is enough signal to flag as "worth a
# second look", per this module's own stated honesty limits).
MODULE_GLOBAL_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\{|\[|dict\(|list\(|set\(|defaultdict\()", re.MULTILINE)

# A write into a name that was declared as a module-level global above:
# NAME[...] = , NAME.append(/.update(/.add(/.pop(/.remove(, NAME += .
def _write_pattern(name):
    escaped = re.escape(name)
    return re.compile(
        rf"(?<![A-Za-z0-9_.]){escaped}\s*(?:\[[^\]]*\]\s*=|\.(?:append|update|add|pop|remove|extend|clear)\s*\(|\+=)"
    )

LOCK_HINT_RE = re.compile(r"\b(threading\.Lock|threading\.RLock|threading\.Semaphore|asyncio\.Lock|Lock\(\)|RLock\(\)|with\s+lock)\b", re.IGNORECASE)
THREAD_HINT_RE = re.compile(r"\b(threading\.Thread|asyncio\.create_task|asyncio\.ensure_future|multiprocessing\.Process)\b")

# Calls whose whole point is a state-changing side effect — a retry loop
# around one of these without an idempotency guard nearby is the specific
# footgun this heuristic is looking for (a retried read is harmless).
MUTATING_CALL_RE = re.compile(
    r"\b(requests\.(post|put|delete|patch)|session\.commit|\.execute\s*\(\s*[\"']\s*(INSERT|UPDATE|DELETE)|cursor\.execute\s*\(\s*[\"']\s*(INSERT|UPDATE|DELETE))\b",
    re.IGNORECASE,
)
RETRY_LOOP_RE = re.compile(r"\b(for\s+\w*attempt\w*\s+in\s+range|while\s+\w*retr(y|ies)\w*|for\s+_\s+in\s+range\([^)]*retr)", re.IGNORECASE)
IDEMPOTENCY_HINT_RE = re.compile(r"\b(idempoten|dedup|nonce|request_id|idempotency_key)\b", re.IGNORECASE)

# Outbound calls worth checking for a timeout. Each entry maps a call-site
# regex to how far past the opening "(" this module looks for `timeout=`
# before concluding one isn't there — generous enough to span a realistic
# multi-line call's other keyword arguments without accidentally matching a
# *different*, later call's timeout.
TIMEOUT_CALL_RE = re.compile(r"\b(requests\.(get|post|put|delete|patch|head)|urllib\.request\.urlopen|subprocess\.(run|call|check_output|check_call))\s*\(")
TIMEOUT_LOOKAHEAD_CHARS = 400

RISK_LABELS = {
    "unsynchronized_shared_state": "Shared mutable state written from multiple places with no visible lock",
    "non_idempotent_retry": "Retry loop around a mutating call with no visible idempotency guard",
    "missing_timeout": "Outbound call with no visible timeout",
    "unsynchronized_background_task": "Background thread/task alongside shared mutable state with no visible lock",
}


def _find_balanced_call_end(text, open_paren_idx):
    """Given the index of a call's opening '(', returns the index just past
    its matching ')' (balanced, accounting for nested parens), or None if
    the text ends before it balances (a truncated excerpt, not a real
    syntax error in the source itself)."""
    depth = 0
    for i in range(open_paren_idx, len(text)):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                return i + 1
    return None


def _line_of(text, idx):
    return text.count("\n", 0, idx) + 1


def detect_concurrency_risks(source_text):
    """source_text: {file_id: raw_text}. Returns {file_id: [finding, ...]}
    for files with at least one finding — files with none are omitted
    entirely, not included with an empty list, so callers never have to
    special-case "no findings" vs "not analyzed". Each finding:
    {"risk_type": ..., "label": ..., "line": int, "detail": str}."""
    results = {}
    for file_id, text in (source_text or {}).items():
        if not text:
            continue
        findings = []

        # --- 1) shared mutable module-level state, no visible lock -------
        globals_found = {m.group(1) for m in MODULE_GLOBAL_RE.finditer(text)}
        has_lock = bool(LOCK_HINT_RE.search(text))
        multiply_written_globals = []
        for name in globals_found:
            writes = list(_write_pattern(name).finditer(text))
            if len(writes) >= 2:
                multiply_written_globals.append((name, writes))
        if multiply_written_globals and not has_lock:
            for name, writes in multiply_written_globals:
                findings.append({
                    "risk_type": "unsynchronized_shared_state",
                    "label": RISK_LABELS["unsynchronized_shared_state"],
                    "line": _line_of(text, writes[0].start()),
                    "detail": f"'{name}' is a module-level mutable container written to in {len(writes)} places in this file, with no threading.Lock/asyncio.Lock visible anywhere in it.",
                })

        # --- 2) retry loop around a mutating call, no idempotency hint ---
        for m in RETRY_LOOP_RE.finditer(text):
            window = text[m.end():m.end() + 600]
            mut = MUTATING_CALL_RE.search(window)
            if mut and not IDEMPOTENCY_HINT_RE.search(window[:mut.end() + 200]):
                findings.append({
                    "risk_type": "non_idempotent_retry",
                    "label": RISK_LABELS["non_idempotent_retry"],
                    "line": _line_of(text, m.start()),
                    "detail": f"A retry loop here wraps what looks like a mutating call ('{mut.group(0)}') with no idempotency-key/nonce/dedup check nearby — a retried write can double-apply.",
                })

        # --- 3) outbound call with no visible timeout ---------------------
        for m in TIMEOUT_CALL_RE.finditer(text):
            end = _find_balanced_call_end(text, text.index("(", m.start()))
            call_text = text[m.start():end] if end else text[m.start():m.start() + TIMEOUT_LOOKAHEAD_CHARS]
            if "timeout" not in call_text.lower():
                findings.append({
                    "risk_type": "missing_timeout",
                    "label": RISK_LABELS["missing_timeout"],
                    "line": _line_of(text, m.start()),
                    "detail": f"'{m.group(1)}(...)' has no timeout= argument — a hung remote end or subprocess would block this call forever.",
                })

        # --- 4) background thread/task alongside unsynchronized state ----
        if THREAD_HINT_RE.search(text) and multiply_written_globals and not has_lock:
            tm = THREAD_HINT_RE.search(text)
            findings.append({
                "risk_type": "unsynchronized_background_task",
                "label": RISK_LABELS["unsynchronized_background_task"],
                "line": _line_of(text, tm.start()),
                "detail": f"This file starts a background thread/task ('{tm.group(1)}') and also writes to module-level shared state from multiple places, with no lock visible in either.",
            })

        if findings:
            results[file_id] = findings
    return results


# --- Request-chain complexity ---------------------------------------------

# Mirrors frontend/src/Dashboard.jsx's classifyTier() exactly, on purpose —
# the two need to agree on what counts as "frontend" for a chain-depth
# number computed here to mean the same thing as the tiered graph the user
# is looking at. Keep these two in sync if either changes.
FRONTEND_FOLDER_NAMES = {"views", "pages", "templates", "ui", "components", "frontend", "client", "web", "screens"}
FRONTEND_EXT_RE = re.compile(r"\.[jt]sx?$")


def classify_tier(node_id, kind):
    if kind == "table":
        return "database"
    rel = (node_id or "").lower()
    if FRONTEND_EXT_RE.search(rel):
        return "frontend"
    return "frontend" if any(seg in FRONTEND_FOLDER_NAMES for seg in rel.split("/")) else "backend"


HIGH_CHAIN_DEPTH = 4  # a request that crosses more than this many hops to reach a table is flagged — tunable, not a universal constant


def chain_complexity(edges, nodes_by_id, high_depth=HIGH_CHAIN_DEPTH):
    """For every database table in nodes_by_id, BFS 'downstream' (who
    depends on this table, transitively — the direction from a table back
    toward the frontend code that ultimately triggers a query against it)
    until the first frontend-tier node is found on each branch, and record
    the minimum hop count across all branches. Returns
    {table_id: {"hops_to_frontend": int|None, "high_complexity": bool,
    "via": [node_id, ...]}}  — hops_to_frontend is None when no frontend-tier
    node is reachable at all (e.g. a table only ever touched from backend
    code with no analyzed frontend layer in this run)."""
    _, in_adj = graph_queries.build_adjacency(edges)
    results = {}
    for node_id, node in nodes_by_id.items():
        if node.get("kind") != "table":
            continue
        visited = {node_id}
        queue = deque([(node_id, 0, [])])
        hops_to_frontend, path = None, []
        while queue:
            current, depth, via_path = queue.popleft()
            for neighbor, _edge_type in in_adj.get(current, []):
                if neighbor in visited:
                    continue
                visited.add(neighbor)
                new_path = via_path + [neighbor]
                neighbor_node = nodes_by_id.get(neighbor)
                neighbor_kind = neighbor_node.get("kind") if neighbor_node else None
                if classify_tier(neighbor, neighbor_kind) == "frontend":
                    hops_to_frontend, path = depth + 1, new_path
                    queue.clear()
                    break
                queue.append((neighbor, depth + 1, new_path))
        results[node_id] = {
            "hops_to_frontend": hops_to_frontend,
            "high_complexity": hops_to_frontend is not None and hops_to_frontend > high_depth,
            "via": path,
        }
    return results
