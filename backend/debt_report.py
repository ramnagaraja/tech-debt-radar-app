"""
Grounded top-N technical debt report.

Ranks the latest analysis run's files and database tables by debt_score and
asks the configured LLM for a specific, cited recommendation set for each of
the top N (default 10) — the same question a user could already ask the Ask
tab ("what are the top 10 debt items and what should we do about them"), but
made a first-class, itemized, persisted artifact instead of a one-off chat
answer.

The one deliberate departure from the Ask tab / "Get recommendations" flow:
confidence is never taken from the LLM's own self-report. It is computed
here, deterministically, from how much real evidence backs each item (score
breakdown, static-analysis findings, flow/concurrency risks, duplicate/
god-file flags, and matched knowledge-base citations) — the same evidence
the LLM is given and asked to ground its recommendations in. An LLM asked to
rate its own confidence tends toward overconfidence; a number computed from
"how many independent real findings does this item actually have" can't be
hallucinated, because it never comes from the model at all. Any item the
model returns that doesn't match one of the exact node_ids it was given is
dropped before storage, and any kb_ref it claims that wasn't actually
retrieved for that item is dropped the same way — a report can never cite a
file, finding, or source document that isn't real.
"""
import json

import knowledge_base
import llm_providers

TOP_N_DEFAULT = 10
KB_TOP_K = 4
KB_MIN_SIMILARITY = 0.35  # mirrors the frontend's KB_MIN_SIMILARITY — below this a match is noise, not a citation

REPORT_JSON_EXAMPLE = (
    '{"items": [{"node_id": "src/example/PlaceholderFile.py", "issue_summary": '
    '"High complexity and a HIGH-severity security finding drive this file\'s score.", '
    '"recommendations": ["Extract the flagged branch into its own function.", '
    '"Parameterize the query named in the security finding."], "kb_refs": ["KB-abc123"]}]}'
)

REPORT_SYSTEM_PROMPT = (
    "You are producing a prioritized technical-debt report for engineering "
    "leadership. You are given the top N highest-debt files/tables in the "
    "codebase, each with its real metrics (score breakdown, static-analysis "
    "findings, flow/concurrency risks, and other debt signals), and, where "
    "relevant, short excerpts from an internal knowledge base of coding "
    "best-practice references. For EVERY item given, respond with a specific "
    "issue summary and one or more concrete recommendations.\n\n"
    "Your entire reply must be a single raw JSON value and nothing else — no "
    "Markdown, no headers, no bold text, no bullet points, no explanation "
    "before or after it. It must be parseable by a strict JSON parser as-is. "
    "The shape is exactly:\n"
    '{"items": [{"node_id": "the exact id given for this item - copy it '
    'verbatim, never alter or invent one", "issue_summary": "1-2 sentences, '
    'grounded ONLY in the specific metrics/findings shown for this item", '
    '"recommendations": ["short, concrete, actionable fix", "..."], '
    '"kb_refs": ["KB-<id>", "..."]}, ...]}\n\n'
    f"Here is a single-item example of the exact format (its content is a "
    f"placeholder only — never reuse its file name, finding, or wording; "
    f"ground every real item in ITS OWN data given below):\n{REPORT_JSON_EXAMPLE}\n\n"
    "Every issue_summary and recommendation must cite something real given "
    "for that item (a score-breakdown component, a named security finding, "
    "a flow-risk label, a duplicate/god-file flag, a schema issue) — never "
    "invent a finding, file, framework, or behavior that wasn't shown. If an "
    "item has nothing beyond its bare debt score to point to, say so plainly "
    "rather than inventing a specific-sounding cause. kb_refs lists only the "
    "[KB-...] tags of reference material you actually used for that item's "
    "recommendation — omit it entirely if none applied; never invent a tag "
    "not listed in the reference material given. Produce exactly one entry "
    "per item given, in the same order, using its exact node_id."
)

REPORT_RETRY_SYSTEM_PROMPT = (
    REPORT_SYSTEM_PROMPT + "\n\nYour previous reply did not parse as JSON — it used "
    "prose or Markdown formatting (headers, bold labels, bullet points) instead. "
    "This time, respond with NOTHING but the raw JSON value itself: your reply's "
    "very first character must be { and its very last character must be }. Do not "
    "wrap it in a ```json code fence, do not add a title or summary line, do not "
    "use ** or # anywhere."
)


def top_n_items(files, tables, n=TOP_N_DEFAULT):
    """Merges files and tables into one ranked pool by debt_score — the same
    "everything is one debt scale" premise the heatmaps and dependency graph
    already use — and returns the top n. Each item is tagged with its own
    "kind" (file|table) and a stable "id" (the same namespaced id used
    everywhere else in the app: FullGraphTab nodes, /api/file-source, /api/
    blast-radius), so a report item can always be traced back to a real node."""
    pool = []
    for f in files or []:
        pool.append({**f, "id": f["file"], "kind": "file"})
    for t in tables or []:
        pool.append({**t, "id": t["file"], "kind": "table"})
    pool.sort(key=lambda x: x.get("debt_score", 0) or 0, reverse=True)
    return pool[:n]


def _evidence_signals(item):
    """The concrete, independently-checkable facts behind one item's score —
    exactly what's handed to the LLM as this item's grounding, and exactly
    what the confidence score below is computed from. Mirrors the same
    fields module_narrative.py's _file_line and Dashboard.jsx's
    synthesizeKbQuery already treat as real findings, just gathered into one
    place for an item that can be either a file or a table."""
    signals = []
    bd = item.get("score_breakdown") or {}
    if bd:
        if item.get("kind") == "table":
            signals.append(
                f"score breakdown: performance={bd.get('performance')} size={bd.get('size')} "
                f"security={bd.get('security')} design={bd.get('design')}"
            )
        else:
            signals.append(
                f"score breakdown: complexity={bd.get('complexity')} churn={bd.get('churn')} "
                f"security={bd.get('security')} design={bd.get('design')}"
            )
    if item.get("security_issue_count"):
        top_sec = (item.get("security_issues") or [])[:3]
        detail = "; ".join(f"[{s.get('severity')}] {s.get('test_id')}: {s.get('text')}" for s in top_sec)
        signals.append(f"security: {item['security_issue_count']} finding(s)" + (f" - {detail}" if detail else ""))
    if item.get("flow_risks"):
        labels = "; ".join(r.get("label", "") for r in item["flow_risks"][:3])
        signals.append(f"flow risks: {len(item['flow_risks'])} - {labels}")
    if (item.get("chain_complexity") or {}).get("high_complexity"):
        hops = item["chain_complexity"].get("hops")
        signals.append(f"request-chain complexity: {hops} hops to the nearest frontend tier (flagged high)")
    if item.get("god_file"):
        signals.append("flagged as a god file (too many responsibilities)")
    if item.get("duplicate_function_count"):
        signals.append(f"{item['duplicate_function_count']} duplicate/near-duplicate function(s)")
    if item.get("long_conditional_chain_count"):
        signals.append(f"{item['long_conditional_chain_count']} long if/switch chain(s)")
    if item.get("missing_primary_key"):
        signals.append("missing primary key")
    if item.get("high_risk_columns"):
        signals.append(f"{len(item['high_risk_columns'])} sensitive column(s)")
    if item.get("public_write_grants"):
        signals.append("PUBLIC write grant(s) on this table")
    if item.get("missing_indexed_fks"):
        signals.append(f"{item['missing_indexed_fks']} unindexed foreign key(s)")
    return signals


def _kb_query_for_item(item):
    """Same intent as Dashboard.jsx's synthesizeKbQuery, kept independent
    (not imported — that one lives in the frontend and builds on client-side
    node-detail fields) since a report is generated server-side without a
    round trip through the browser."""
    bits = [item.get("id") or item.get("file")]
    if item.get("security_issues"):
        bits.append(" ".join(i.get("test_id", "") for i in item["security_issues"][:3]))
    if item.get("god_file"):
        bits.append("single responsibility principle god object")
    if item.get("duplicate_function_count"):
        bits.append("DRY duplicated code reusability")
    if item.get("long_conditional_chain_count"):
        bits.append("open closed principle strategy pattern polymorphism")
    if item.get("flow_risks"):
        bits.append(" ".join(r.get("risk_type", "") for r in item["flow_risks"][:3]).replace("_", " "))
    if (item.get("chain_complexity") or {}).get("high_complexity"):
        bits.append("chatty synchronous call chains request latency microservices")
    if item.get("missing_primary_key") or item.get("high_risk_columns"):
        bits.append("database schema design sensitive data columns")
    return " ".join(b for b in bits if b)


def _kb_line(hit):
    page = f" (p.{hit['page']})" if hit.get("page") else ""
    return f"  [KB-{hit['chunk_id']}] {hit['filename']}{page}: {hit['text'][:400]}"


def _confidence_from_evidence(signal_count, kb_hit):
    """Deterministic, never LLM-reported — the number of independent real
    findings behind an item drives it, not the model's own say-so. An item
    resting on nothing but its bare debt score (no specific finding, no
    matched reference) is explicitly Low rather than dressed up as certain;
    that's the honesty framing flow_risk_analyzer and coupling_analyzer
    already use for their own findings, applied to the report as a whole."""
    n = signal_count + (1 if kb_hit else 0)
    if n >= 3:
        return "High", round(min(0.7 + 0.06 * (n - 3), 0.95), 2)
    if n >= 1:
        return "Medium", round(0.45 + 0.12 * n, 2)
    return "Low", 0.25


REPORT_MAX_ATTEMPTS = 3  # one normal try, then two increasingly forceful "JSON only" retries


def generate_report(items, provider, model, api_key, base_url=None):
    """items: the already-ranked top-N list from top_n_items(). Calls the
    configured LLM (up to REPORT_MAX_ATTEMPTS times, only retrying on a
    parse failure) for the whole report. Returns
    {"ok": True, "items": [...]} or {"ok": False, "error": "..."} — never
    raises, so a report failure surfaces as a clear error rather than a
    crashed background thread. A model that answers in prose/Markdown
    instead of JSON (some fast/small models do, especially on a long,
    many-item prompt like this one) gets increasingly blunt reminders
    rather than being asked the exact same way three times."""
    if not items:
        return {"ok": False, "error": "No analyzed files or tables to report on yet — run an analysis first."}

    known_ids = {it["id"] for it in items}
    evidence_by_id = {}
    prompt_blocks = []
    for rank, it in enumerate(items, start=1):
        signals = _evidence_signals(it)
        kb_query = _kb_query_for_item(it)
        kb_hits = []
        if kb_query:
            try:
                kb_hits = [r for r in knowledge_base.search(kb_query, top_k=KB_TOP_K) if r["similarity"] >= KB_MIN_SIMILARITY]
            except Exception:
                kb_hits = []
        evidence_by_id[it["id"]] = {"signals": signals, "kb_hits": kb_hits, "item": it, "rank": rank}
        kb_text = "\n".join(_kb_line(h) for h in kb_hits)
        kind_label = "database table" if it["kind"] == "table" else "file"
        prompt_blocks.append(
            f"Item {rank} — node_id: \"{it['id']}\" ({kind_label}, debt_score {it.get('debt_score', 0) or 0:.2f})\n"
            "Evidence:\n" + ("\n".join(f"  - {s}" for s in signals) if signals else "  - (only the debt score itself — no specific finding to cite)")
            + (f"\nRelevant reference material:\n{kb_text}" if kb_text else "")
        )

    user_content = f"Top {len(items)} highest-debt items in the codebase, most urgent first:\n\n" + "\n\n".join(prompt_blocks)

    last_error, last_text = None, ""
    for attempt in range(REPORT_MAX_ATTEMPTS):
        system_prompt = REPORT_SYSTEM_PROMPT if attempt == 0 else REPORT_RETRY_SYSTEM_PROMPT
        prompt = user_content if attempt == 0 else (
            user_content + "\n\nReminder: respond with ONLY the raw JSON object — your reply must "
            "start with { and end with }, with no Markdown, headers, bold text, or bullet points "
            "anywhere in it."
        )
        try:
            # max_tokens well above module_narrative.py's per-module 2600: this
            # prompt covers up to 10 items (each with a summary, one or more
            # recommendations, and kb_refs) in one response, and a reasoning-
            # capable model can spend a meaningful chunk of the budget on
            # invisible "thinking" tokens before writing anything visible — a
            # too-tight cap here doesn't fail loudly, it produces a plausible-
            # looking but truncated, unparseable fragment. json_mode asks the
            # API itself to constrain the output to valid JSON, as a second,
            # independent safeguard alongside the prompt instructions above.
            text = llm_providers.call_llm(
                provider, model, api_key, system_prompt,
                [{"role": "user", "content": prompt}], max_tokens=8000, base_url=base_url, json_mode=True,
            )
            last_text = text
            parsed = llm_providers.extract_json(text, expect="object")
            raw_items = parsed.get("items") or []
            out_items = []
            for ri in raw_items:
                if not isinstance(ri, dict):
                    continue
                node_id = ri.get("node_id")
                # Hallucination guard: an item the model returns that doesn't
                # match one of the exact node_ids it was actually given is
                # dropped, never stored — a report can't cite a file that
                # isn't real.
                if node_id not in known_ids:
                    continue
                ev = evidence_by_id[node_id]
                recs = [r.strip() for r in (ri.get("recommendations") or []) if isinstance(r, str) and r.strip()]
                if not recs:
                    continue
                valid_kb_ids = {f"KB-{h['chunk_id']}" for h in ev["kb_hits"]}
                kb_refs = sorted({r for r in (ri.get("kb_refs") or []) if isinstance(r, str)} & valid_kb_ids)
                label, score = _confidence_from_evidence(len(ev["signals"]), bool(kb_refs))
                out_items.append({
                    "node_id": node_id, "kind": ev["item"]["kind"], "rank": ev["rank"],
                    "debt_score": ev["item"].get("debt_score", 0) or 0,
                    "issue_summary": (ri.get("issue_summary") or "").strip(),
                    "recommendations": recs,
                    "confidence_label": label, "confidence_score": score,
                    "evidence_signals": ev["signals"], "kb_refs": kb_refs,
                })
            # Cover every item the report was actually asked about, even if
            # the model skipped one — a report that silently dropped one of
            # its top 10 would be a worse failure mode than an entry that
            # honestly says the model didn't answer for it.
            covered = {o["node_id"] for o in out_items}
            for node_id, ev in evidence_by_id.items():
                if node_id in covered:
                    continue
                label, score = _confidence_from_evidence(len(ev["signals"]), False)
                out_items.append({
                    "node_id": node_id, "kind": ev["item"]["kind"], "rank": ev["rank"],
                    "debt_score": ev["item"].get("debt_score", 0) or 0,
                    "issue_summary": "The model didn't return a usable entry for this item.",
                    "recommendations": [], "confidence_label": label, "confidence_score": score,
                    "evidence_signals": ev["signals"], "kb_refs": [],
                })
            out_items.sort(key=lambda o: o["rank"])
            return {"ok": True, "items": out_items}
        except Exception as e:
            last_error = e

    preview = (last_text or "").strip().replace("\n", " ")[:220]
    detail = f' The model\'s last response started: "{preview}{"…" if len(last_text.strip()) > 220 else ""}"' if preview else " The model's last response was empty."
    return {"ok": False, "error": f"Could not generate report after {REPORT_MAX_ATTEMPTS} attempts ({last_error}).{detail}"}
