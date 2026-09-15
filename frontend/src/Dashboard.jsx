import React, { useState, useMemo, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ResponsiveContainer, Treemap, Tooltip as RTooltip, LineChart, Line, XAxis, YAxis } from "recharts";
import * as d3 from "d3";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Flame, GitBranch, MessageCircle, Database, ThumbsUp, ThumbsDown, Search, ArrowRight,
  Clock, Send, RefreshCw, Info, Sparkles, ShieldAlert, X, Settings, AlertTriangle, Palette, FileText, Workflow,
  Check, Loader2, TrendingUp, GitPullRequestArrow, Boxes, RotateCw, ClipboardList,
} from "lucide-react";
import AdminPanel from "./AdminPanel.jsx";
import { STEP_LABELS } from "./SetupScreen.jsx";

const CHAT_API_URL = "/api/chat";

function debtColor(score) {
  const stops = [
    [0, [16, 185, 129]],   // emerald-500 — healthy
    [0.5, [245, 158, 11]], // amber-500  — moderate
    [1, [220, 38, 38]],    // red-600    — high debt
  ];
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (score >= stops[i][0] && score <= stops[i + 1][0]) { lo = stops[i]; hi = stops[i + 1]; break; }
  }
  const span = hi[0] - lo[0] || 1;
  const t = Math.max(0, Math.min(1, (score - lo[0]) / span));
  const c = lo[1].map((v, i) => Math.round(v + (hi[1][i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function shortName(path) { return path.split("/").pop(); }

// Perceptual luminance — decides whether text on a debt-colored background
// should be white or dark, so labels stay readable at every point on the
// green→amber→red scale (mid-amber is too light for white text).
function textOnColor(rgbString) {
  const [r, g, b] = rgbString.match(/\d+/g).map(Number);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#16281F" : "#FFFFFF";
}

function InfoIcon({ text, size = 12 }) {
  const [show, setShow] = useState(false);
  const [coords, setCoords] = useState(null);
  const iconRef = useRef(null);
  const TOOLTIP_WIDTH = 260;

  function computeAndOpen() {
    const rect = iconRef.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 12;
    let left = rect.left + rect.width / 2 - TOOLTIP_WIDTH / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - TOOLTIP_WIDTH - margin));
    // Flip below the icon if there isn't room above it (e.g. near the top of a scrolled panel).
    const opensUp = rect.top > 90;
    setCoords({ left, anchorX: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom, opensUp });
    setShow(true);
  }

  return (
    <span
      ref={iconRef}
      onMouseEnter={computeAndOpen}
      onMouseLeave={() => setShow(false)}
      onClick={(e) => { e.stopPropagation(); show ? setShow(false) : computeAndOpen(); }}
      style={{ position: "relative", display: "inline-flex", marginLeft: 5, cursor: "help", verticalAlign: "middle" }}
    >
      <Info size={size} color="#93A7BF" />
      {show && coords && createPortal(
        <div style={{
          position: "fixed", zIndex: 9999, left: coords.left,
          top: coords.opensUp ? coords.top - 8 : coords.bottom + 8,
          transform: coords.opensUp ? "translateY(-100%)" : "none",
          width: TOOLTIP_WIDTH, boxSizing: "border-box", background: "#0F2540", color: "#EAF2FB",
          fontSize: 11.5, lineHeight: 1.55, padding: "10px 12px", borderRadius: 9,
          boxShadow: "0 12px 28px rgba(15,37,64,0.30)", pointerEvents: "none", wordBreak: "normal", overflowWrap: "break-word",
        }}>
          {text}
          <div style={{
            position: "absolute", left: Math.max(10, Math.min(coords.anchorX - coords.left, TOOLTIP_WIDTH - 10)),
            transform: "translateX(-50%)", width: 0, height: 0,
            ...(coords.opensUp
              ? { top: "100%", borderLeft: "5px solid transparent", borderRight: "5px solid transparent", borderTop: "5px solid #0F2540" }
              : { bottom: "100%", borderLeft: "5px solid transparent", borderRight: "5px solid transparent", borderBottom: "5px solid #0F2540" }),
          }} />
        </div>,
        document.body
      )}
    </span>
  );
}

const CODE_METRIC_INFO = {
  loc: "Total lines of code in the file, including blank lines and comments (radon for Python, Roslyn for .NET, the TypeScript compiler for TS/React/Angular). Used as the treemap tile size — bigger files are easier to spot at a glance.",
  avg_complexity: "Average cyclomatic complexity across all functions in this file (radon for Python, Roslyn for .NET, the TypeScript compiler for TS/React/Angular). Cyclomatic complexity counts independent decision paths (if/for/while/catch branches) — more branching means a higher number. Above ~10 per function is generally considered hard to test and maintain.",
  max_complexity: "The single most complex function in this file — its highest cyclomatic complexity score. A high max with a low average usually means one function needs breaking up, even if the rest of the file looks fine.",
  maintainability_index: "A 0–100 composite score computed from Halstead volume, cyclomatic complexity, and lines of code together. Below 65 is generally considered hard to maintain; below 20 is very difficult. This is the single biggest input to the 'design' slice of the debt score.",
  churn: "Number of commits touching this file in the last 2 years, from git log. Frequently-changed files carry more risk per edit and are weighted into the debt score — a file that's both complex AND frequently touched is the classic hotspot.",
  long_function_count: "Functions longer than 50 lines in this file, detected by walking the file's syntax tree. A classic 'this function does too much' smell — one of several signals feeding the design score.",
  max_nesting_depth: "The deepest level of nested if/for/while/try blocks found in any function in this file. Deep nesting (past ~4 levels) makes code hard to follow and easy to break; also feeds the design score.",
  many_params_count: "Functions with more than 5 parameters in this file — often a sign a function is doing too much and would benefit from being split or taking a parameter object instead.",
  duplicate_function_count: "Functions in this file whose structure matches a function elsewhere in this analysis — identifiers and literals are ignored, so a copy-paste with renamed variables still counts. Compared across every repo in this run, not just this file — a reusability signal: the same logic living in two places instead of one.",
  public_function_count: "Public functions/methods declared in this file (module-level defs in Python; public methods in .NET; exported functions/classes in TypeScript — a module's actual visibility unit). A high count on one file is a rough single-responsibility proxy — it may be doing several unrelated jobs that could be split into smaller, more focused units.",
  long_conditional_chain_count: "if/elif (or switch/match) chains in this file with more than 5 branches. A classic open/closed-principle smell — this dispatch logic often reads more clearly, and is easier to extend, as polymorphism or a lookup table instead.",
  any_usage_count: "TypeScript only. Count of explicit ': any' type annotations and 'as any' casts. Each one is a hole in the type system the compiler can no longer check — the design-practices doc's top rule is 'avoid using any; prefer unknown, narrowed via a type guard'.",
  non_strict_typescript: "TypeScript only. Whether this repo's tsconfig.json has \"strict\": true (or noImplicitAny + strictNullChecks individually). A repo-wide fact applied to every file in it, not something unique to this one file.",
  static_utility_class_count: "TypeScript/JavaScript. Exported classes in this file where every member is 'static' — a 'sprawling static utility class' the design-practices doc calls out; plain exported functions are more tree-shakable and just as reusable.",
  many_boolean_props_count: "TypeScript only. React '*Props' interfaces with more than 4 boolean members, or Angular components with more than 4 boolean @Input()s — the design-practices doc's 'avoid dozens of boolean flags; prefer control inversion via slotting' made concrete.",
  fan_out: "Number of other files this file imports from (or references, for .NET). High fan-out means this file depends on a lot of moving parts — changes elsewhere in the codebase are more likely to affect it.",
  fan_in: "Number of other files that import/reference this one — its 'blast radius'. High fan-in means changes to this file are more likely to ripple outward and break something else; a good signal for prioritizing what to make safe to change first.",
  security_issue_count: "Total findings from real static analysis run against this file (bandit for Python; a Roslyn semantic-analysis pass for .NET; a syntactic TypeScript-AST pass for TS/React/Angular — SQL injection, XSS via dangerouslySetInnerHTML/innerHTML, Angular sanitizer bypasses, weak crypto, hardcoded secrets, insecure deserialization, command injection). Each finding has a severity (LOW/MEDIUM/HIGH) and a confidence level, both of which weight how much they move the debt score.",
};

const DB_METRIC_INFO = {
  row_estimate: "Live row count from the database's own catalog statistics when connected live (Postgres pg_class.reltuples, MySQL information_schema.TABLES, or SQL Server sys.partitions), or unknown when analyzed from a schema file only. Bigger tables carry more operational risk per change.",
  column_count: "Number of columns declared on this table. Very wide tables (past ~15 columns) are flagged as a design concern — often a sign the table is doing more than one job.",
  fk_out: "Number of foreign key constraints this table declares pointing at other tables — how many other tables this one directly depends on.",
  fk_in: "Number of other tables that have a foreign key pointing at this one — this table's 'blast radius' in the data model. High fan-in means schema changes here are more likely to break something downstream.",
  missing_indexed_fks: "Foreign key columns on this table that have no covering index, checked against the database's own index catalog. An unindexed FK usually means slow joins and slow cascading deletes as the table grows — a real, checkable performance issue, not a guess.",
  missing_primary_key: "Whether this table has no PRIMARY KEY constraint declared. Tables without a primary key are harder to safely update, replicate, or deduplicate, and are a common source of subtle bugs.",
  high_risk_columns: "Columns whose names match common sensitive-data patterns (password, api_key, ssn, credit_card, etc.) with no 'hash'/'encrypted' qualifier in the name. This is a name-pattern check on the schema, not an inspection of actual stored values.",
  public_write_grants: "Number of INSERT/UPDATE/DELETE privileges granted broadly on this table (the PUBLIC role on Postgres/SQL Server, or a wildcard-host grant as the closest MySQL equivalent), read from the database's own grant catalog — a real, checkable over-permissioning signal, only available with a live connection.",
};

const WEIGHT_INFO = {
  complexity: "How tangled the code's control flow is (cyclomatic complexity) — more independent branches means more paths to test and more ways to introduce a bug.",
  churn: "How often this file has changed in the last 2 years (git history). Frequent changes compound risk from the other factors — a hotspot is complex AND frequently touched.",
  security: "Real findings from static analysis: bandit or a Roslyn semantic pass for code (SQL injection patterns, hardcoded secrets, unsafe deserialization, etc.) or schema checks for data (exposed sensitive columns, over-permissive grants).",
  design: "A blend of maintainability index, long functions, deep nesting, too many parameters, oversized files, duplicate/near-duplicate code, high public surface (SRP proxy), and long if/switch chains (OCP proxy) for code — or missing primary key, unenforced relationships, and table width for data.",
  performance: "Checkable performance risk — currently just foreign keys with no covering index, which slows joins and cascading deletes as a table grows.",
  size: "Table size by row count — bigger tables carry more operational weight per schema or query change.",
};

const CODE_WEIGHTS = [
  ["complexity", "Complexity", 35],
  ["churn", "Churn (recent activity)", 20],
  ["security", "Security (static analysis findings)", 25],
  ["design", "Design & best practices", 20],
];
const DB_WEIGHTS = [
  ["performance", "Performance (unindexed FKs)", 30],
  ["security", "Security (sensitive columns, grants)", 30],
  ["design", "Design & integrity", 25],
  ["size", "Table size", 15],
];

function ScoreBreakdown({ breakdown, weights, detail }) {
  const [open, setOpen] = useState(false);
  if (!breakdown) return null;
  return (
    <div style={{ marginBottom: 14 }}>
      <button onClick={() => setOpen((o) => !o)}
        style={{ display: "flex", alignItems: "center", gap: 5, background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 11.5, color: "#0369A1", fontWeight: 600 }}>
        <Info size={12} /> {open ? "Hide score breakdown" : "How is this score calculated?"}
      </button>
      {open && (
        <div style={{ marginTop: 9, background: "#F3F8FD", border: "1px solid #DCEAF6", borderRadius: 9, padding: 11 }}>
          {weights.map(([key, label, weightPct]) => (
            <div key={key} style={{ marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#3A4E68", marginBottom: 3 }}>
                <span style={{ display: "flex", alignItems: "center" }}>
                  {label} <span style={{ color: "#93A7BF", marginLeft: 4 }}>({weightPct}% weight)</span>
                  {WEIGHT_INFO[key] && <InfoIcon text={WEIGHT_INFO[key]} size={11} />}
                </span>
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 600 }}>{((breakdown[key] ?? 0) * 100).toFixed(0)}%</span>
              </div>
              <div style={{ height: 5, background: "#E1EBF5", borderRadius: 3 }}>
                <div style={{ height: "100%", width: `${(breakdown[key] ?? 0) * 100}%`, background: debtColor(breakdown[key] ?? 0), borderRadius: 3 }} />
              </div>
              {detail && key === "design" && detail && (
                <div style={{ marginTop: 5, marginLeft: 4, display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {Object.entries(detail).map(([k, v]) => (
                    <span key={k} style={{ fontSize: 9.5, color: "#7B8FA8", background: "#FFFFFF", border: "1px solid #E1EBF5", borderRadius: 5, padding: "1.5px 5px" }}>
                      {k.replace(/_/g, " ")}: {(v * 100).toFixed(0)}%
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
async function loadFeedback() {
  try {
    const stored = await window.storage?.get?.("debt-radar-feedback", false);
    if (stored?.value) return JSON.parse(stored.value);
  } catch (e) {}
  try {
    const raw = localStorage.getItem("debt-radar-feedback");
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  return {};
}
async function saveFeedback(next) {
  try { await window.storage?.set?.("debt-radar-feedback", JSON.stringify(next), false); return; } catch (e) {}
  try { localStorage.setItem("debt-radar-feedback", JSON.stringify(next)); } catch (e) {}
}

// ---------------------------------------------------------------------------
// Generic heatmap (used for both code files and DB tables)
// ---------------------------------------------------------------------------
function TreemapCell({ x, y, width, height, item, depth, selected, onClick }) {
  if (width < 2 || height < 2) return null;
  // Recharts calls this once for the invisible root wrapper (depth 0) and,
  // for grouped/nested data, once per directory-group boundary (depth 1,
  // no debt_score — its 'id' is recharts' own auto-generated one, not ours,
  // so use 'name' which recharts does preserve correctly at every depth).
  if (depth === 0) return null;
  if (item.debt_score === undefined) {
    if (width < 6 || height < 6) return null;
    return (
      <g>
        <rect x={x} y={y} width={width} height={height} fill="none" stroke="#C7DBEE" strokeWidth={1.5} rx={6} />
        {width > 46 && height > 16 && (
          <text x={x + 7} y={y + 13} fontSize={10} fontFamily="'IBM Plex Mono', monospace" fill="#5B7290" fontWeight={700}>{item.name}</text>
        )}
      </g>
    );
  }
  const fill = debtColor(item.debt_score);
  const textColor = textOnColor(fill);
  const showLabel = width > 46 && height > 22;
  const showDebt = showLabel && height > 40 && width > 60;
  return (
    <g onClick={() => onClick(item)} style={{ cursor: "pointer" }}>
      <rect x={x} y={y} width={width} height={height} fill={fill}
        stroke="#FFFFFF" strokeWidth={selected?.id === item.id ? 3 : 2} rx={4}
        opacity={selected && selected.id !== item.id ? 0.5 : 1}
        style={{ filter: selected?.id === item.id ? "drop-shadow(0 2px 6px rgba(15,37,64,0.35))" : "none" }} />
      {showLabel && (
        <text x={x + 8} y={y + 18} fontSize={12} fontFamily="'IBM Plex Mono', monospace" fill={textColor} fontWeight={700}>
          {shortName(item.id).length > Math.floor(width / 7.2) ? shortName(item.id).slice(0, Math.floor(width / 7.2) - 1) + "…" : shortName(item.id)}
        </text>
      )}
      {showDebt && (
        <text x={x + 8} y={y + 34} fontSize={10.5} fontFamily="'IBM Plex Mono', monospace" fill={textColor} opacity={0.85}>debt {item.debt_score.toFixed(2)}</text>
      )}
    </g>
  );
}

function formatMetricValue(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "None";
  return value;
}

function MetricRow({ label, value, sub, info }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "6px 0", borderBottom: "1px solid #EEF3F9" }}>
      <span style={{ fontSize: 12.5, color: "#5B7290", display: "flex", alignItems: "center" }}>
        {label}
        {info && <InfoIcon text={info} />}
        {sub ? <span style={{ fontSize: 10, color: "#93A7BF", marginLeft: 6 }}>({sub})</span> : null}
      </span>
      <span style={{ fontSize: 13.5, fontFamily: "'IBM Plex Mono', monospace", color: "#0F2540", fontWeight: 600, textAlign: "right", maxWidth: "55%" }}>{formatMetricValue(value)}</span>
    </div>
  );
}

function HeatmapTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const d = payload[0].payload;
  if (!d || d.debt_score === undefined) return null;
  return (
    <div style={{ background: "#0F2540", color: "#EAF2FB", fontSize: 11.5, padding: "9px 12px", borderRadius: 8, boxShadow: "0 10px 24px rgba(15,37,64,0.3)", maxWidth: 220 }}>
      <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, marginBottom: 4, wordBreak: "break-all" }}>{d.id}</div>
      <div>debt score: <b>{d.debt_score.toFixed(2)}</b></div>
      {d.avg_complexity !== undefined && <div>avg complexity: {d.avg_complexity}</div>}
      {d.row_estimate !== undefined && d.row_estimate !== null && <div>rows: {d.row_estimate.toLocaleString()}</div>}
      <div style={{ color: "#93A7BF", marginTop: 3 }}>Click to pin details →</div>
    </div>
  );
}

// Groups files by their top-level directory so the treemap reads as
// clusters of related files rather than 30+ same-looking flat tiles.
function groupByDirectory(items) {
  const groups = {};
  for (const item of items) {
    const parts = item.id.split("/");
    const dir = parts.length > 1 ? parts[0] : "(root)";
    groups[dir] = groups[dir] || [];
    groups[dir].push({ ...item, name: item.id, size: Math.max(item.loc || item.row_estimate || 1, 20) });
  }
  return Object.entries(groups)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([dir, children]) => ({ name: dir, children }));
}

// Debt-score trend for one node across past analysis runs, plus any durable
// gotchas mined from this repo's PR history for that same file — both are
// read-only overlays on data the analysis (and, for PR insights, a separate
// opt-in mining step) already computed; neither triggers new work on its own.
function NodeTrendAndInsights({ nodeId }) {
  const [trend, setTrend] = useState({ loading: true, points: [] });
  const [insights, setInsights] = useState({ loading: true, items: [] });

  useEffect(() => {
    let cancelled = false;
    setTrend({ loading: true, points: [] });
    setInsights({ loading: true, items: [] });
    fetch(`/api/trend?node_id=${encodeURIComponent(nodeId)}`).then((r) => r.json())
      .then((d) => { if (!cancelled) setTrend({ loading: false, points: d.points || [] }); })
      .catch(() => { if (!cancelled) setTrend({ loading: false, points: [] }); });
    fetch(`/api/pr-insights?file_id=${encodeURIComponent(nodeId)}`).then((r) => r.json())
      .then((d) => { if (!cancelled) setInsights({ loading: false, items: d.items || [] }); })
      .catch(() => { if (!cancelled) setInsights({ loading: false, items: [] }); });
    return () => { cancelled = true; };
  }, [nodeId]);

  if (trend.loading || (trend.points.length < 2 && insights.items.length === 0)) return null;

  return (
    <div style={{ marginTop: 4, marginBottom: 14 }}>
      {trend.points.length >= 2 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#5B7290", marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}>
            <TrendingUp size={12} /> Debt trend across {trend.points.length} runs
          </div>
          <div style={{ height: 56 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={trend.points} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                <XAxis dataKey="run_id" hide />
                <YAxis domain={[0, 1]} hide />
                <Line type="monotone" dataKey="debt_score" stroke="#0EA5E9" strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
                <RTooltip formatter={(v) => v.toFixed(2)} labelFormatter={() => ""} contentStyle={{ fontSize: 11, padding: "4px 8px" }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
      {insights.items.length > 0 && (
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#5B7290", marginBottom: 4, display: "flex", alignItems: "center", gap: 4 }}>
            <GitPullRequestArrow size={12} /> From PR history
          </div>
          {insights.items.slice(0, 5).map((it) => (
            <div key={it.id} style={{ fontSize: 11, color: "#3A4E68", background: "#FBFDFF", border: "1px solid #E1EBF5", borderRadius: 7, padding: "6px 8px", marginBottom: 5, lineHeight: 1.45 }}>
              {it.insight} {it.source_pr && <span style={{ color: "#93A7BF" }}>(PR #{it.source_pr})</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HeatmapPane({ items, sizeKey, legendNote, selected, setSelected, goToDeps, detailFields, groupByDir }) {
  const treeData = useMemo(() => {
    if (groupByDir) return groupByDirectory(items);
    return items.map((f) => ({ ...f, name: f.id, size: Math.max(f[sizeKey] || 1, 20) }));
  }, [items, sizeKey, groupByDir]);
  if (items.length === 0) return <div style={{ fontSize: 13, color: "#93A7BF", padding: 30 }}>No data for this view.</div>;
  return (
    <div style={{ display: "flex", gap: 20, height: "100%" }}>
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
          <p style={{ margin: 0, fontSize: 13, color: "#5B7290" }}>{legendNote}</p>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5, color: "#5B7290" }}>
            <span>Healthy</span>
            <div style={{ width: 90, height: 8, borderRadius: 4, background: "linear-gradient(90deg, rgb(16,185,129), rgb(245,158,11), rgb(220,38,38))" }} />
            <span>High debt</span>
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 380, background: "#FFFFFF", border: "1px solid #E1EBF5", borderRadius: 12, padding: 8 }}>
          <ResponsiveContainer width="100%" height="100%">
            <Treemap data={treeData} dataKey="size" stroke="#FFFFFF" isAnimationActive={false}
              content={(props) => <TreemapCell {...props} item={props} selected={selected} onClick={setSelected} />}>
              <RTooltip content={<HeatmapTooltip />} />
            </Treemap>
          </ResponsiveContainer>
        </div>
      </div>
      <div style={{ width: 300, flexShrink: 0 }}>
        {selected ? (
          <div style={{ background: "#FFFFFF", border: "1px solid #E1EBF5", borderRadius: 12, padding: 18, maxHeight: 560, overflowY: "auto" }}>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: "#0F2540", wordBreak: "break-all", marginBottom: 4 }}>{selected.id}</div>
            <div style={{ display: "inline-block", fontSize: 11.5, padding: "2px 8px", borderRadius: 99, background: debtColor(selected.debt_score), color: textOnColor(debtColor(selected.debt_score)), marginBottom: 10, fontWeight: 700 }}>
              debt score {selected.debt_score.toFixed(2)}
            </div>
            <ScoreBreakdown breakdown={selected.score_breakdown} weights={selected.kind === "table" ? DB_WEIGHTS : CODE_WEIGHTS} detail={selected.score_breakdown?.design_detail} />
            {selected.kind === "file" && (selected.security_issue_count > 0) && (
              <div style={{ background: "#FDECEC", border: "1px solid #F8C9C9", borderRadius: 8, padding: "8px 10px", marginBottom: 12, fontSize: 11.5, color: "#9F1D1D" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5, fontWeight: 700, marginBottom: 4 }}><ShieldAlert size={12} /> {selected.security_issue_count} security finding{selected.security_issue_count === 1 ? "" : "s"} ({selected.security_high_count} high)</div>
                {selected.security_issues?.slice(0, 3).map((iss, i) => (
                  <div key={i} style={{ marginTop: 3 }}>· [{iss.severity}] {iss.test_id}: {iss.text}</div>
                ))}
              </div>
            )}
            {selected.kind === "table" && (selected.high_risk_columns?.length > 0 || selected.missing_primary_key || selected.unenforced_relationships?.length > 0) && (
              <div style={{ background: "#FDECEC", border: "1px solid #F8C9C9", borderRadius: 8, padding: "8px 10px", marginBottom: 12, fontSize: 11.5, color: "#9F1D1D" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5, fontWeight: 700, marginBottom: 4 }}><ShieldAlert size={12} /> Data risk flags</div>
                {selected.high_risk_columns?.length > 0 && <div>· Sensitive columns: {selected.high_risk_columns.join(", ")}</div>}
                {selected.missing_primary_key && <div>· No primary key declared</div>}
                {selected.unenforced_relationships?.length > 0 && <div>· Unenforced FK-like columns: {selected.unenforced_relationships.join(", ")}</div>}
                {selected.public_write_grants > 0 && <div>· {selected.public_write_grants} PUBLIC write grant(s)</div>}
              </div>
            )}
            {detailFields.map(([label, key, sub]) => <MetricRow key={key} label={label} value={selected[key]} sub={sub} info={(selected.kind === "table" ? DB_METRIC_INFO : CODE_METRIC_INFO)[key]} />)}
            <NodeTrendAndInsights nodeId={selected.id} />
            <button onClick={() => goToDeps(selected.id)}
              style={{ marginTop: 12, width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "9px 0", background: "#0EA5E9", color: "white", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              View dependency map <ArrowRight size={14} />
            </button>
          </div>
        ) : (
          <div style={{ background: "#F3F8FD", border: "1px dashed #C7DBEE", borderRadius: 12, padding: 18, fontSize: 13, color: "#5B7290" }}>Select a tile to see its metrics.</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dependency graph — full interactive canvas: zoom, pan, drag, click-to-focus.
// No side panel needed — clicking a node highlights its neighborhood directly
// and shows a small floating card next to it.
// ---------------------------------------------------------------------------
// Implicit runtime couplings (coupling_analyzer.py) never share a color with
// a "real" (compile-time) edge type — they're a different kind of claim
// (heuristic, regex-detected) and should read that way at a glance.
const COUPLING_EDGE_COLOR = "#DB2777"; // pink — implicit runtime coupling (any coupling_* type)
const COUPLING_EDGE_LABELS = {
  coupling_redis: "Shared Redis key/connection",
  coupling_kafka: "Shared Kafka topic/broker",
  coupling_queue: "Shared queue/exchange (AMQP/SQS/SNS/etc.)",
  coupling_shared_key: "Shared literal key (unclassified library)",
};
function isCouplingEdge(edgeType) { return typeof edgeType === "string" && edgeType.startsWith("coupling_"); }

function edgeColor(edgeType) {
  if (edgeType === "code_to_table") return "#F59E0B"; // amber, dashed
  if (edgeType === "db_fk") return "#6366F1"; // indigo
  if (isCouplingEdge(edgeType)) return COUPLING_EDGE_COLOR;
  return "#94A3B8"; // slate — code_import
}

function nodeRadius(d) {
  const degree = (d.fan_in ?? d.fk_in ?? 0) + (d.fan_out ?? d.fk_out ?? 0);
  return Math.max(7, Math.min(22, 7 + Math.sqrt(degree) * 3.2));
}

// --- Dependency-flow tiering (frontend / backend / database) -------------
// A heuristic, not a universal fact: a real frontend-language file is an
// unambiguous signal, but a lot of this app's analyzed repos are
// server-rendered monoliths with no separate frontend language at all, so a
// folder-name convention is the fallback for "this is the presentation/entry
// layer" (e.g. a Python app's own views/ directory). Checked against every
// path segment, not just the first, so it still works once a repo name
// namespaces the id (multi-repo runs prefix ids with "reponame/...").
const FRONTEND_FOLDER_NAMES = new Set(["views", "pages", "templates", "ui", "components", "frontend", "client", "web", "screens"]);

function classifyTier(node) {
  if (node.kind === "table") return "database";
  const relPath = node.id || node.file || "";
  if (/\.[jt]sx?$/.test(relPath)) return "frontend"; // a real frontend-language file
  const segments = relPath.toLowerCase().split("/");
  return segments.some((s) => FRONTEND_FOLDER_NAMES.has(s)) ? "frontend" : "backend";
}

const TIER_ORDER = ["frontend", "backend", "database"];
const TIER_LABELS = { frontend: "Frontend", backend: "Backend", database: "Database" };
// Same debt_score formula already used everywhere else in the app (heatmaps,
// node detail panels) — just averaged across every item placed in this tier,
// so the basis for this number is never a mystery.
const TIER_SCORE_INFO = {
  frontend: "Average of each file's overall debt_score across every item classified into this tier (a real frontend-language file, or a file under a views/pages/components/ui-style folder). Each file's own score is 35% complexity + 20% churn + 25% security + 20% design — see that file's own detail panel for its breakdown.",
  backend: "Average of each file's overall debt_score across every item classified into this tier (everything not matched as frontend or a database table — core/services/modules-style code). Each file's own score is 35% complexity + 20% churn + 25% security + 20% design — see that file's own detail panel for its breakdown.",
  database: "Average of each table's overall debt_score across every table in this analysis. Each table's own score is 30% performance (unindexed foreign keys) + 15% size + 30% security (sensitive columns, broad write grants) + 25% design (missing primary key, unenforced relationships, table width) — see that table's own detail panel for its breakdown.",
};
const TIER_BAND_FILLS = { frontend: "#EFF6FF", backend: "#F0FDF4", database: "#FDF4FF" };

// Shared between the graph's initial draw and the highlight-pass reset, so a
// tiered layout's "cross-tier edges are the real story" emphasis survives
// clicking a node and then clicking away again. Only meaningful once the
// simulation has resolved link.source/target from ids to node objects.
function baseEdgeOpacity(d, tiered) {
  if (tiered && d.source && typeof d.source === "object") {
    return classifyTier(d.source) === classifyTier(d.target) ? 0.12 : 0.6;
  }
  return 0.45;
}
function baseEdgeWidth(d, tiered) {
  if (tiered && d.source && typeof d.source === "object") {
    return classifyTier(d.source) === classifyTier(d.target) ? 1.2 : 2;
  }
  return 1.2;
}

// --- Knowledge base retrieval (RAG) ---------------------------------------
// The frontend orchestrates this the same way it already orchestrates
// /api/file-source and Jira/Confluence context: fetch first, fold into the
// prompt, then call /api/chat — keeping that endpoint generic. Sources are
// always shown (not just when the model's prose happens to cite them) so
// "what the library actually had" stays visible regardless of how the
// model's answer reads.
const KB_MIN_SIMILARITY = 0.35; // below this, a match is noise, not a citation

async function searchKnowledgeBase(query, topK = 4) {
  if (!query || !query.trim()) return [];
  try {
    const res = await fetch("/api/knowledge/search", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, top_k: topK }),
    });
    const json = await res.json();
    return (json.results || []).filter((r) => r.similarity >= KB_MIN_SIMILARITY);
  } catch {
    return []; // no knowledge base yet, or the search failed — grounding still works without it
  }
}

// Fire-and-forget: every Ask-tab answer and every "Get recommendations" call
// gets logged here, tagged with the run_id current when it happened (data.run_id,
// stamped onto the metrics payload by run_analysis()/record_run_history() —
// undefined/null for data loaded before this run-tagging existed, or if no
// analysis has ever been run, which the backend accepts fine). This is what
// backs the Admin panel's "Run history" comparison view — never awaited by a
// caller, and never allowed to interrupt the chat/recommendation flow it
// rides along with if the log write itself fails.
function logChatExchange({ runId, kind, nodeId, question, answer, kbQuery, sources }) {
  fetch("/api/chat-history", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      run_id: runId ?? null, kind, node_id: nodeId ?? null, question, answer,
      kb_query: kbQuery ?? null, sources: (sources || []).map((s) => s.chunk_id ?? s),
    }),
  }).catch(() => {});
}

function synthesizeKbQuery(node, outs = [], ins = []) {
  if (!node) return "";
  if (node.kind === "table") {
    const bits = ["database schema design", node.missing_primary_key ? "missing primary key" : null,
      node.high_risk_columns?.length ? "sensitive data columns" : null,
      node.unenforced_relationships?.length ? "unenforced foreign key relationships" : null,
      // ties chain_complexity (flow_risk_analyzer.chain_complexity, attached
      // server-side during analysis) into KB retrieval — a table with an
      // unusually deep request chain back to the frontend matches the same
      // chatty-call-chain guidance already written for backend services.
      node.chain_complexity?.high_complexity ? "chatty synchronous call chains request latency microservices" : null];
    return bits.filter(Boolean).join(" ");
  }
  // Translate the same design-smell signals already used for badges into terms
  // that actually match the bundled SOLID/design-pattern/microservices/API/
  // integration/frontend reference docs, so "Get recommendations" retrieves
  // real grounding for exactly the kind of critique its system prompt already
  // asks for, not just team-uploaded docs.
  const isTs = /\.[jt]sx?$/.test(node.id || node.file || "");
  const bits = [
    (node.security_issues || []).map((i) => i.test_id).join(" "),
    (node.god_file || (node.public_function_count ?? 0) > 15) ? "single responsibility principle god object" : null,
    node.long_conditional_chain_count ? "open closed principle strategy pattern polymorphism" : null,
    node.duplicate_function_count ? "DRY duplicated code reusability" : null,
    node.static_utility_class_count ? "static utility class anti-pattern tree-shakable" : null,
    node.many_boolean_props_count ? (isTs ? "compound components control inversion boolean prop sprawl" : "control inversion boolean flag anti-pattern") : null,
    ((outs?.length ?? 0) + (ins?.length ?? 0) > 12) ? "microservices coupling bounded context service boundaries" : null,
    // flow_risk_analyzer.detect_concurrency_risks findings, attached
    // server-side during analysis — retrieve the matching idempotency/
    // integration guidance instead of only generic SOLID/pattern material.
    (node.flow_risks || []).some((r) => r.risk_type === "non_idempotent_retry") ? "idempotency key retry safety idempotent consumer" : null,
    (node.flow_risks || []).some((r) => r.risk_type === "unsynchronized_shared_state" || r.risk_type === "unsynchronized_background_task") ? "shared mutable state race condition synchronization" : null,
    (node.flow_risks || []).some((r) => r.risk_type === "missing_timeout") ? "resilience circuit breaker timeout" : null,
    isTs ? [
      node.any_usage_count ? "typescript strict mode any type unknown type safety" : null,
      node.non_strict_typescript ? "typescript strict mode discriminated union branded type" : null,
      (node.avg_complexity ?? 0) > 10 || node.long_function_count ? "container presentational custom hooks state colocation" : null,
    ].filter(Boolean).join(" ") : null,
  ];
  return bits.filter(Boolean).join(" ") || node.file;
}

function confidenceColor(level) {
  if (level === "High") return { bg: "#E7F9F1", fg: "#0F7B4E" };
  if (level === "Medium") return { bg: "#FEF3E2", fg: "#B45309" };
  return { bg: "#F3F4F6", fg: "#6B7280" };
}

function KnowledgeSourcesPanel({ sources, query }) {
  const [voted, setVoted] = useState({});
  if (!sources || sources.length === 0) return null;

  async function vote(chunkId, dir) {
    setVoted((v) => ({ ...v, [chunkId]: dir }));
    try {
      await fetch("/api/knowledge/feedback", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chunk_id: chunkId, vote: dir, query }),
      });
    } catch {
      // best-effort — the vote just won't count toward future ranking this time
    }
  }

  return (
    <div style={{ marginTop: 10, borderTop: "1px dashed #DCEAF6", paddingTop: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "#5B7290", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.3 }}>
        Knowledge base sources
      </div>
      {sources.map((s) => {
        const c = confidenceColor(s.confidence);
        return (
          <div key={s.chunk_id} style={{ display: "flex", alignItems: "flex-start", gap: 8, background: "#FBFDFF", border: "1px solid #E1EBF5", borderRadius: 8, padding: "8px 10px", marginBottom: 6 }}>
            <FileText size={14} color="#93A7BF" style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 3 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "#0F2540" }}>{s.filename}{s.page ? ` · p.${s.page}` : ""}</span>
                {s.is_builtin && (
                  <span title="Bundled with the app — SOLID, GoF design patterns, microservices, API design, integration patterns, and frontend best practices" style={{ fontSize: 9.5, fontWeight: 700, color: "#5B3FA8", background: "#F1ECFB", padding: "1px 6px", borderRadius: 99 }}>
                    Industry reference
                  </span>
                )}
                <span style={{ fontSize: 9.5, fontWeight: 700, color: c.fg, background: c.bg, padding: "1px 6px", borderRadius: 99 }}>
                  {s.confidence} match ({Math.round(s.similarity * 100)}%)
                </span>
                {s.trust_multiplier !== 1 && (
                  <span title="Adjusted by past team feedback on this source" style={{ fontSize: 9.5, color: "#93A7BF" }}>
                    · feedback-adjusted {s.trust_multiplier > 1 ? "↑" : "↓"}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11.5, color: "#5B7290", lineHeight: 1.4 }}>{s.text.slice(0, 220)}{s.text.length > 220 ? "…" : ""}</div>
            </div>
            <div style={{ display: "flex", gap: 3, flexShrink: 0 }}>
              <button onClick={() => vote(s.chunk_id, "up")} title="Helpful source"
                style={{ background: "none", border: "none", cursor: "pointer", padding: 3, color: voted[s.chunk_id] === "up" ? "#0EA5E9" : "#B7C4D6" }}>
                <ThumbsUp size={13} />
              </button>
              <button onClick={() => vote(s.chunk_id, "down")} title="Not helpful"
                style={{ background: "none", border: "none", cursor: "pointer", padding: 3, color: voted[s.chunk_id] === "down" ? "#DC2626" : "#B7C4D6" }}>
                <ThumbsDown size={13} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Shared by the Ask tab and "Get recommendations": a single trailing
// confidence line can't be pinned to any one claim once an answer covers
// several distinct findings — exactly when a team most needs to know which
// specific claims to trust. Requiring the tag (and, where one applies, the
// citation) on each item instead keeps both traceable to the exact line
// that earned them, and asking for bold inline tags rather than a table
// keeps the format identical regardless of which of the three providers
// (Claude, Gemini, or a local Ollama model) answers it.
const PER_ITEM_CONFIDENCE_INSTRUCTION = "If the question asks for a specific number of items (e.g. \"top 10\"), produce exactly that many, numbered — never stop early or pad with fewer just because the answer already feels long enough. Every distinct fix, finding, or recommendation in a numbered or bulleted list must end with its own confidence tag in the exact inline form '**(Confidence: High|Medium|Low)**' — reflecting how directly THAT specific item is supported by the data or code actually shown, not one blanket confidence for the whole answer. If, and only if, a specific piece of retrieved reference material genuinely informed that particular item, immediately follow its confidence tag with that item's exact citation tag, e.g. '**(Confidence: High)** [KB-abc123]' — never attach a citation to an item it didn't actually inform, and never fabricate a tag that isn't listed in the reference material given. Prefer a numbered or bulleted list over a table for anything enumerable (e.g. a \"top N\" list of files or fixes) — a table cell can't hold this per-item tag. Only a short answer making one single claim, with no enumerable list, should end with one overall confidence tag in this same form instead. Show any arithmetic (e.g. a projected debt-score improvement) as plain prose or a simple 'a - b = c' line, never LaTeX/math-block notation ($$...$$ or \\text{}) — this renderer displays that literally instead of typesetting it.";

// Condensed from the team's attached "Front End Design Practices" document —
// used verbatim in the recommendation system prompt for .ts/.tsx files so the
// AI's critique is grounded in the team's own stated practices, not generic
// training-data React/Angular advice.
const FRONTEND_DESIGN_PRACTICES = `Front-end design practices this team follows:

Universal TypeScript:
- Strict type checking ("strict": true, noImplicitAny, strictNullChecks, noUncheckedIndexedAccess). Avoid "any"; prefer "unknown" narrowed via type guards or a validation library (e.g. Zod).
- Domain-driven typing over primitives: discriminated unions for multi-state flows (Idle | Loading | Success | Error), branded types for entity IDs to prevent mismatched-ID bugs.
- Separate DTOs (API contracts) from client-side domain models; map at the boundary so breaking API changes don't propagate into components.
- Folder-by-feature (features/billing/) over folder-by-technical-role (a top-level components/), with a public barrel index.ts per feature.

React patterns:
- Container/Presentational (smart vs. dumb): presentational components render from props only; containers (or custom hooks) own data fetching, side effects, and state mutation.
- Custom hooks for logic decoupling (useUserPermissions(), useDebounce()) — prefer hooks over legacy HOCs and render props.
- Compound components (Tabs, Accordion, Dropdown) sharing state via Context, not prop drilling.
- State colocation: keep state as close as possible to where it's used; don't push transient state (modal toggles, form inputs) to a global store.
- Control inversion via slotting: pass JSX as props/children rather than a config object with dozens of boolean flags.

Angular patterns:
- Signals-based reactivity (signal(), computed(), effect()) over zone-based dirty checking or complex RxJS operator chains.
- Facade pattern: components talk only to a Facade service, which exposes read-only signals/observables and command methods, mediating RxJS/NgRx/HTTP underneath.
- Smart (routed) vs. dumb (presentational) components — dumb components use explicit input()/output() and ChangeDetectionStrategy.OnPush.
- DI tokens (InjectionToken) to abstract external integrations/config, enabling mock injection and runtime strategy swaps.
- Functional interceptors (HttpInterceptorFn) and guards (CanActivateFn) over class-based ones.

State management: server state via TanStack Query (React) / TanStack Query Angular or RxJS caching (Angular) — stale-while-revalidate, retries, cache invalidation by key. Global client state via Zustand/Jotai (React) or NgRx SignalStore/BehaviorSubject services (Angular) — immutability, command-query separation, single source of truth. Local/form state via React Hook Form + Zod (React) or Angular Reactive/Typed Forms (Angular) — schema-driven validation.

Performance & maintainability: lazy-load and code-split at routing boundaries (React.lazy/Suspense; Angular loadComponent/loadChildren, @defer). Favor tree-shakable pure functions/ESM exports over sprawling static utility classes. Never mutate state/arrays directly — use immutable updates (spread, or Immer) to preserve reference-identity checks across renders.`;

function buildNodeRecommendationPrompt(data, node, outs, ins, sourceCode) {
  const isTable = node.kind === "table";
  const lines = [`Item: ${node.id} (${isTable ? "database table" : "code file"})`, `Debt score: ${node.debt_score}`];
  if (!isTable) {
    lines.push(`Avg complexity: ${node.avg_complexity} | Max complexity: ${node.max_complexity} | Maintainability index: ${node.maintainability_index}`);
    lines.push(`Churn (2yr commits): ${node.churn} | Long functions: ${node.long_function_count} | Max nesting depth: ${node.max_nesting_depth} | God file: ${node.god_file}`);
    lines.push(`Duplicate/near-duplicate functions (matched elsewhere in this analysis): ${node.duplicate_function_count ?? 0} | Public functions/methods: ${node.public_function_count ?? 0} | Long if/switch chains (>5 branches): ${node.long_conditional_chain_count ?? 0}`);
    if (/\.[jt]sx?$/.test(node.id)) {
      lines.push(`'any' usages: ${node.any_usage_count ?? 0} | tsconfig strict mode off: ${node.non_strict_typescript ? "yes" : "no"} | All-static utility classes: ${node.static_utility_class_count ?? 0} | Components/props with >4 boolean flags: ${node.many_boolean_props_count ?? 0}`);
    }
    if (node.security_issue_count > 0) {
      lines.push(`Security findings (${node.security_issue_count}, ${node.security_high_count} high):`);
      (node.security_issues || []).forEach((iss) => lines.push(`  - [${iss.severity}] ${iss.test_id}: ${iss.text} (line ${iss.line})`));
    }
  } else {
    lines.push(`Rows: ${node.row_estimate ?? "unknown"} | Columns: ${node.column_count} | Missing indexed FKs: ${node.missing_indexed_fks ?? "unknown"}`);
    if (node.high_risk_columns?.length) lines.push(`High-risk columns exposed: ${node.high_risk_columns.join(", ")}`);
    if (node.missing_primary_key) lines.push(`No primary key declared.`);
    if (node.unenforced_relationships?.length) lines.push(`Columns that look like foreign keys but aren't enforced: ${node.unenforced_relationships.join(", ")}`);
    if (node.public_write_grants) lines.push(`${node.public_write_grants} PUBLIC write grant(s) on this table.`);
  }
  lines.push(`Depends on: ${outs.map((n) => n.id).join(", ") || "none"}`);
  lines.push(`Depended on by: ${ins.map((n) => n.id).join(", ") || "none"}`);
  const extCtx = buildExternalContextSection(data);
  if (extCtx.trim()) lines.push(extCtx.trim());
  if (sourceCode) {
    lines.push(`\nFull source of ${node.id}${sourceCode.truncated ? " (truncated)" : ""}:\n\`\`\`\n${sourceCode.source}\n\`\`\``);
  }
  return lines.join("\n");
}

function colorValueFor(d, colorBy) {
  if (colorBy === "debt" || !d.score_breakdown) return d.debt_score ?? 0;
  return d.score_breakdown[colorBy] ?? d.debt_score ?? 0;
}

const COLOR_BY_OPTIONS = [
  ["debt", "Overall debt"],
  ["design", "Design concerns"],
  ["security", "Security concerns"],
];

function FullGraphTab({ nodesById, edges, data, focal, setFocal, filterKind, tiered, emptyLabel }) {
  const svgRef = useRef(null);
  const nodeSelRef = useRef(null);
  const linkSelRef = useRef(null);
  const simNodesRef = useRef([]);
  const zoomRef = useRef(null);
  const [query, setQuery] = useState("");
  const [colorBy, setColorBy] = useState("debt");
  const [recommendation, setRecommendation] = useState({ forId: null, loading: false, text: "", error: false, sources: [], kbQuery: "" });
  const [recVoted, setRecVoted] = useState({}); // { [nodeId]: "up" | "down" } — this session's own votes, for button highlighting
  const [recentRecDownvotes, setRecentRecDownvotes] = useState([]);
  const [blastRadius, setBlastRadius] = useState({ forId: null, loading: false, data: null, error: null, direction: "both" });
  // getRecommendations/fetchBlastRadius are plain functions re-created every
  // render, but the D3 draw effect below only re-runs when [nodes,
  // scopedEdges, setFocal, tiered] change — referencing them directly inside
  // that effect would close over whichever version existed the last time it
  // ran, silently calling a stale one after any other state change. A ref
  // updated on every render (cheap — just a reassignment, not an effect) and
  // read from inside the D3 event handler sidesteps that without forcing a
  // full graph redraw on every keystroke/state change elsewhere on the page.
  const latestActionsRef = useRef(null);

  useEffect(() => {
    fetch("/api/feedback/recent?vote=down&scope=recommendation&limit=5").then((r) => r.json()).then((d) => setRecentRecDownvotes(d.items || [])).catch(() => {});
  }, []);

  const nodes = useMemo(() => {
    const all = Object.values(nodesById);
    return filterKind ? all.filter((n) => n.kind === filterKind) : all;
  }, [nodesById, filterKind]);
  const nodeIdSet = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);
  const scopedEdges = useMemo(() => {
    const base = filterKind ? edges.filter((e) => e.edge_type !== "code_to_table") : edges;
    return base.filter((e) => nodeIdSet.has(e.source) && nodeIdSet.has(e.target));
  }, [edges, filterKind, nodeIdSet]);

  // Per-tier summary strip (tiered layout only) — average debt + node count
  // per tier, so where debt concentrates along the flow is visible without
  // clicking into individual nodes.
  const tierSummary = useMemo(() => {
    if (!tiered) return null;
    const byTier = { frontend: [], backend: [], database: [] };
    for (const n of nodes) byTier[classifyTier(n)].push(n);
    return TIER_ORDER.map((t) => ({
      tier: t, count: byTier[t].length,
      avgDebt: byTier[t].length ? byTier[t].reduce((s, n) => s + (n.debt_score || 0), 0) / byTier[t].length : null,
    })).filter((t) => t.count > 0);
  }, [tiered, nodes]);

  // Repo <-> database links (tiered layout only, and only when there's more
  // than one repo or more than one database — a single-repo/single-db run
  // has nothing to disambiguate). Derived entirely from code_to_table edges
  // already in the payload: an edge's source is a repo-namespaced file id,
  // its target resolves to a table row whose "db" field names the owning
  // database (multi_source.py sets this unconditionally) — so which repo
  // actually talks to which database falls out of data already computed,
  // no new setup step needed.
  const repoDbLinks = useMemo(() => {
    if (!tiered) return null;
    const repos = data.repos || [];
    const databases = data.databases || [];
    if (repos.length <= 1 && databases.length <= 1) return null;

    const tableById = {};
    for (const t of (data.tables || [])) tableById[t.file] = t;
    const dbNameBySlug = {};
    for (const d of databases) dbNameBySlug[d.slug] = d.name;

    const referencedDbSlugs = new Set();
    const perRepo = repos.map((r) => {
      const prefix = repos.length > 1 ? `${r.slug}/` : null;
      const tablesByDb = {}; // dbSlug -> Set(table ids)
      for (const e of scopedEdges) {
        if (e.edge_type !== "code_to_table") continue;
        if (prefix && !e.source.startsWith(prefix)) continue;
        const table = tableById[e.target];
        if (!table) continue;
        referencedDbSlugs.add(table.db);
        (tablesByDb[table.db] = tablesByDb[table.db] || new Set()).add(e.target);
      }
      const links = Object.entries(tablesByDb).map(([slug, tables]) => ({
        slug, name: dbNameBySlug[slug] || slug, tableCount: tables.size,
      }));
      return { repo: r, links };
    });
    const orphanDbs = databases.filter((d) => !referencedDbSlugs.has(d.slug));
    return { perRepo, orphanDbs };
  }, [tiered, data, scopedEdges]);

  const scopedNodesById = useMemo(() => {
    const m = {};
    for (const n of nodes) m[n.id] = n;
    return m;
  }, [nodes]);

  function isTypescriptFile(node) {
    return node.kind !== "table" && /\.[jt]sx?$/.test(node.id);
  }

  async function getRecommendations(node, outs, ins) {
    setRecommendation({ forId: node.id, loading: true, text: "", error: false, sources: [], kbQuery: "" });
    try {
      let sourceCode = null;
      if (node.kind !== "table") {
        try {
          const srcRes = await fetch(`/api/file-source?id=${encodeURIComponent(node.id)}`);
          const srcJson = await srcRes.json();
          if (srcJson.ok) sourceCode = srcJson;
        } catch {
          // no source available (e.g. re-analyzed elsewhere since) — recommendations still work, just metrics-only
        }
      }

      const kbQuery = synthesizeKbQuery(node, outs, ins);
      const kbSources = await searchKnowledgeBase(kbQuery);
      const kbSection = kbSources.length
        ? `\n\nReference material retrieved from the knowledge base — a mix of the team's own uploaded documents and this app's bundled industry-standard references on SOLID principles, the full Gang-of-Four design pattern catalog, microservices architecture, API design, integration patterns, and frontend best practices (cite by its [KB-...] tag when you use it — don't invent a citation for anything not listed here):\n${kbSources.map((s) => `[KB-${s.chunk_id}] ${s.filename}${s.page ? ` (p.${s.page})` : ""}: ${s.text}`).join("\n\n")}`
        : "";

      // Same in-context conditioning loop as the Ask tab (ChatTab.recentDownvotes)
      // applied to recommendations: a real, persisted vote log changes the very
      // next recommendation's prompt. This is NOT gradient-based reinforcement
      // learning — no model weights are updated.
      const feedbackNote = recentRecDownvotes.length
        ? `\n\nThe team has previously down-voted these recommendations as unhelpful — avoid repeating the same mistakes (vague claims, missing specifics, ignoring a relevant metric or reference):\n${recentRecDownvotes.map((f, i) => `${i + 1}. For "${f.question}", the down-voted recommendation was: "${f.answer.slice(0, 200)}..."`).join("\n")}`
        : "";

      const prompt = buildNodeRecommendationPrompt(data, node, outs, ins, sourceCode) + kbSection;
      let systemPrompt;
      if (sourceCode && isTypescriptFile(node)) {
        systemPrompt =
          "You are a staff frontend engineer giving remediation guidance for one specific TypeScript file (React, Angular, or generic) in an engineering-debt dashboard, and you have been given its real source code below the metrics. Use the metrics as signal for WHAT to focus on, and the real source for HOW to fix it. Judge the code against the team's own front-end design practices, quoted in full below — cite the specific practice a piece of code violates, don't just say 'follow best practices'. Structure your answer in markdown with these sections: '## What's driving the debt score' (2-3 sentences tying the score components to what you see in the actual code), '## Design-practice critique' (call out specific violations of the practices below you can see in the real code — strict typing, container/presentational or smart/dumb separation, hooks vs HOCs, Signals vs zone-based reactivity, state colocation, DI tokens, immutability, tree-shakability — whichever actually apply to this file, not a generic checklist), '## Recommended fixes' (a prioritized numbered list, most impactful first, each with a one-line why and, where it clarifies the fix, a short before/after fenced code block quoting the actual lines), and '## Quick win' (the single smallest change that would help soonest). Ground every suggestion in the actual code shown — never invent code that isn't there.\n\n"
          + FRONTEND_DESIGN_PRACTICES;
      } else if (sourceCode) {
        systemPrompt =
          "You are a staff engineer giving remediation guidance for one specific code file in an engineering-debt dashboard, and you have been given its real source code below the metrics. Use the metrics as signal for WHAT to focus on, and the real source for HOW to fix it. Structure your answer in markdown with these sections: '## What's driving the debt score' (2-3 sentences tying the score components to what you see in the actual code), '## SOLID / design-pattern / reusability critique' (call out specific violations you can see in the real code — SRP, OCP, duplicated logic, tight coupling — not generic principles), '## Recommended fixes' (a prioritized numbered list, most impactful first, each with a one-line why and, where it clarifies the fix, a short before/after fenced code block quoting the actual lines), and '## Quick win' (the single smallest change that would help soonest). Ground every suggestion in the actual code shown — never invent code that isn't there.";
      } else {
        systemPrompt =
          "You are a staff engineer giving remediation guidance for one specific file or database table in an engineering-debt dashboard. Use ONLY the data given — never invent metrics. Structure your answer in markdown with these sections: '## What's driving the debt score' (2-3 sentences tying the score components to what you see), '## Recommended fixes' (a prioritized numbered list, most impactful first, each with a one-line why), and '## Quick win' (the single smallest change that would help soonest). Be concrete and specific to the actual metrics/issues listed, not generic advice.";
      }
      systemPrompt += "\n\n" + PER_ITEM_CONFIDENCE_INSTRUCTION;
      if (kbSources.length) {
        systemPrompt += "\n\nSome reference material is included below the metrics, each tagged [KB-<id>] — a mix of the team's own uploaded documents and this app's bundled industry-standard references on SOLID principles, the Gang-of-Four design pattern catalog, microservices architecture, API design, integration patterns, and frontend best practices.";
      }
      systemPrompt += feedbackNote;

      const res = await fetch(CHAT_API_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Generous headroom: a "be thorough" system prompt plus a model that
          // can spend some of this budget on internal reasoning before it
          // writes visible text means a tight cap risks a truncated or even
          // fully empty answer (all budget spent reasoning, none left to write).
          // Per-item confidence/citation tags also add real length to a long
          // "Recommended fixes" list — confirmed via direct testing that 8192
          // still truncated a demanding answer before Claude accepted 16384
          // with no complaint, so recommendations get real margin here too.
          max_tokens: sourceCode ? 6000 : 4000,
          system: systemPrompt,
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const json = await res.json();
      const text = (json.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n") || "No response.";
      // When the provider call itself failed (json.error), nothing was
      // actually grounded in the retrieved sources — showing them next to an
      // error message would look like citations for an answer that doesn't exist.
      setRecommendation({ forId: node.id, loading: false, text, error: !!json.error, sources: json.error ? [] : kbSources, kbQuery });
      if (!json.error) {
        logChatExchange({ runId: data.run_id, kind: "recommendation", nodeId: node.id, question: `Recommendations for ${node.id}`, answer: text, kbQuery, sources: kbSources });
      }
    } catch (e) {
      setRecommendation({ forId: node.id, loading: false, text: "Couldn't reach the guidance model.", error: true, sources: [], kbQuery: "" });
    }
  }

  async function fetchBlastRadius(nodeId, direction) {
    setBlastRadius({ forId: nodeId, loading: true, data: null, error: null, direction });
    try {
      const res = await fetch(`/api/blast-radius?node_id=${encodeURIComponent(nodeId)}&direction=${direction}&max_depth=3`);
      const json = await res.json();
      if (!json.ok) { setBlastRadius({ forId: nodeId, loading: false, data: null, error: json.error || "Couldn't compute blast radius.", direction }); return; }
      setBlastRadius({ forId: nodeId, loading: false, data: json, error: null, direction });
    } catch {
      setBlastRadius({ forId: nodeId, loading: false, data: null, error: "Couldn't reach the server.", direction });
    }
  }

  async function voteOnRecommendation(dir) {
    const nodeId = recommendation.forId;
    if (!nodeId) return;
    setRecVoted((v) => ({ ...v, [nodeId]: dir }));
    try {
      await fetch("/api/feedback", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: recommendation.kbQuery || nodeId, answer: recommendation.text, vote: dir, node_id: nodeId }),
      });
      if (dir === "down") {
        fetch("/api/feedback/recent?vote=down&scope=recommendation&limit=5").then((r) => r.json()).then((d) => setRecentRecDownvotes(d.items || []));
      }
    } catch { /* feedback persistence is best-effort */ }
  }

  useEffect(() => {
    if (!svgRef.current || nodes.length === 0) return;
    const width = 900, height = 560;
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();
    svg.attr("viewBox", `0 0 ${width} ${height}`);

    const zoomLayer = svg.append("g");
    svg.append("defs").append("marker").attr("id", "arrow").attr("viewBox", "0 -4 8 8").attr("refX", 20).attr("refY", 0)
      .attr("markerWidth", 6).attr("markerHeight", 6).attr("orient", "auto")
      .append("path").attr("d", "M0,-4L8,0L0,4").attr("fill", "#CBD5E1");

    const simNodes = nodes.map((n) => ({ ...n }));
    const nodeById = Object.fromEntries(simNodes.map((n) => [n.id, n]));
    const simLinks = scopedEdges.filter((e) => nodeById[e.source] && nodeById[e.target]).map((e) => ({ ...e }));
    simNodesRef.current = simNodes;

    // Tiered layout: columns (Frontend | Backend | Database, 2 columns if no
    // DB was analyzed) instead of one free-floating blob — laneX below pins
    // each node's x-force target to its tier's column center.
    let activeTiers = null, laneX = null, laneStep = 0;
    if (tiered) {
      const present = new Set(simNodes.map((n) => classifyTier(n)));
      activeTiers = TIER_ORDER.filter((t) => present.has(t));
      const margin = 90;
      laneStep = activeTiers.length > 1 ? (width - margin * 2) / (activeTiers.length - 1) : 0;
      laneX = (tier) => (activeTiers.length > 1 ? margin + activeTiers.indexOf(tier) * laneStep : width / 2);

      const bandWidth = activeTiers.length > 1 ? laneStep * 0.92 : width * 0.6;
      zoomLayer.append("g").selectAll("rect.tier-band").data(activeTiers).join("rect")
        .attr("x", (t) => laneX(t) - bandWidth / 2).attr("y", 8)
        .attr("width", bandWidth).attr("height", height - 16).attr("rx", 10)
        .attr("fill", (t) => TIER_BAND_FILLS[t] || "#F8FAFC");
      zoomLayer.append("g").selectAll("text.tier-label").data(activeTiers).join("text")
        .attr("x", (t) => laneX(t)).attr("y", 26).attr("text-anchor", "middle")
        .attr("font-size", 11).attr("font-weight", 700).attr("letter-spacing", 0.6)
        .attr("fill", "#93A7BF").text((t) => TIER_LABELS[t].toUpperCase());

      // Chevrons in the gap between adjacent bands, reinforcing that this is
      // a left-to-right request path, not just three unordered groups.
      if (activeTiers.length > 1) {
        const chevronYs = [height * 0.28, height * 0.5, height * 0.72];
        const chevronData = [];
        for (let i = 0; i < activeTiers.length - 1; i++) {
          const cx = (laneX(activeTiers[i]) + bandWidth / 2 + laneX(activeTiers[i + 1]) - bandWidth / 2) / 2;
          chevronYs.forEach((cy) => chevronData.push({ cx, cy }));
        }
        zoomLayer.append("g").selectAll("path.flow-chevron").data(chevronData).join("path")
          .attr("d", "M -5,-7 L 6,0 L -5,7")
          .attr("transform", (d) => `translate(${d.cx},${d.cy})`)
          .attr("fill", "none").attr("stroke", "#C7D6E8").attr("stroke-width", 2.2)
          .attr("stroke-linecap", "round").attr("stroke-linejoin", "round")
          .attr("pointer-events", "none");
      }
    }

    const sim = d3.forceSimulation(simNodes)
      .force("link", d3.forceLink(simLinks).id((d) => d.id).distance(65).strength(0.22))
      .force("charge", d3.forceManyBody().strength(-130))
      .force("collide", d3.forceCollide((d) => nodeRadius(d) + 8));
    if (tiered) {
      sim.force("x", d3.forceX((d) => laneX(classifyTier(d))).strength(0.35));
      sim.force("y", d3.forceY(height / 2).strength(0.05));
    } else {
      sim.force("center", d3.forceCenter(width / 2, height / 2));
    }

    // Once forceLink resolves link.source/target from ids to node objects
    // (synchronous, done by the .force("link", ...) call above), a tiered
    // layout can tell a cross-tier edge — the actual flow of communication
    // this view exists to surface — from the dense same-tier mesh around it.
    const linkSel = zoomLayer.append("g").selectAll("line").data(simLinks).join("line")
      .attr("stroke", (d) => edgeColor(d.edge_type))
      .attr("stroke-width", (d) => baseEdgeWidth(d, tiered))
      .attr("stroke-dasharray", (d) => (d.edge_type === "code_to_table" ? "3,3" : isCouplingEdge(d.edge_type) ? "1,3" : null))
      .attr("opacity", (d) => baseEdgeOpacity(d, tiered))
      .attr("marker-end", "url(#arrow)");
    linkSelRef.current = linkSel;

    const nodeSel = zoomLayer.append("g").selectAll("g.node").data(simNodes, (d) => d.id).join("g")
      .attr("class", "node").style("cursor", "pointer");

    nodeSel.each(function (d) {
      const sel = d3.select(this);
      const r = nodeRadius(d);
      if (d.kind === "table") {
        sel.append("rect").attr("x", -r * 0.82).attr("y", -r * 0.82).attr("width", r * 1.64).attr("height", r * 1.64).attr("rx", 4);
      } else {
        sel.append("circle").attr("r", r);
      }
    });
    nodeSel.select("rect, circle")
      .attr("fill", (d) => debtColor(colorValueFor(d, colorBy)))
      .attr("stroke", "#FFFFFF").attr("stroke-width", 1.8);

    nodeSel.append("text")
      .attr("y", (d) => nodeRadius(d) + 12)
      .attr("text-anchor", "middle").attr("font-size", 9.5)
      .attr("font-family", "'IBM Plex Mono', monospace").attr("fill", "#3A4E68")
      .attr("paint-order", "stroke").attr("stroke", "#F5F9FD").attr("stroke-width", 3)
      .text((d) => shortName(d.id));

    // Small warning badge for nodes flow_risk_analyzer flagged: a file with
    // a concurrency/edge-case finding, or a table whose request chain back
    // to the frontend is unusually deep. Purely a "worth a second look"
    // signal at a glance — the actual findings/hop count live in the focal
    // side panel once a node is clicked.
    const flagged = nodeSel.filter((d) => (d.flow_risks && d.flow_risks.length > 0) || d.chain_complexity?.high_complexity);
    flagged.append("circle")
      .attr("cx", (d) => nodeRadius(d) * 0.68).attr("cy", (d) => -nodeRadius(d) * 0.68)
      .attr("r", 7.5).attr("fill", "#F59E0B").attr("stroke", "#FFFFFF").attr("stroke-width", 1.5);
    flagged.append("text")
      .attr("x", (d) => nodeRadius(d) * 0.68).attr("y", (d) => -nodeRadius(d) * 0.68 + 3.3)
      .attr("text-anchor", "middle").attr("font-size", 10).attr("font-weight", 800)
      .attr("fill", "#FFFFFF").style("pointer-events", "none").text("!");
    flagged.append("title").text((d) => {
      const parts = [];
      if (d.flow_risks?.length) parts.push(`${d.flow_risks.length} concurrency/edge-case finding${d.flow_risks.length === 1 ? "" : "s"}`);
      if (d.chain_complexity?.high_complexity) parts.push(`deep request chain (${d.chain_complexity.hops_to_frontend} hops to frontend)`);
      return parts.join(" · ");
    });

    nodeSel.on("click", (event, d) => { event.stopPropagation(); setFocal(d.id); });
    svg.on("click", () => setFocal(null));

    // Double-click a node to skip the two extra manual button presses:
    // focus it AND immediately kick off both "Get recommendations" and a
    // both-directions blast radius, so the side panel opens already
    // populated. outs/ins are recomputed here (not read from the render
    // body's `outs`/`ins`, which are only ever for the currently-focal
    // node) using scopedEdges/scopedNodesById, both already in this
    // effect's own closure and safe — scopedEdges is a declared dependency
    // below, and scopedNodesById is derived solely from `nodes`, also a
    // dependency, so both are current whenever this effect body runs.
    nodeSel.on("dblclick", (event, d) => {
      event.stopPropagation();
      const actions = latestActionsRef.current;
      if (!actions) return;
      const dOuts = scopedEdges.filter((e) => e.source === d.id).map((e) => scopedNodesById[e.target]).filter(Boolean);
      const dIns = scopedEdges.filter((e) => e.target === d.id).map((e) => scopedNodesById[e.source]).filter(Boolean);
      setFocal(d.id);
      actions.getRecommendations(d, dOuts, dIns);
      actions.fetchBlastRadius(d.id, "both");
    });

    // Deliberately no per-node drag: it used to compete with canvas panning
    // for the same pointer gesture, and since nodes are large and densely
    // packed, almost every attempted "drag to pan" actually grabbed a node
    // instead — snapping it (and, via the collide/link forces, its
    // neighbors) into a chaotic new position instead of moving the camera,
    // which is exactly what a map-style zoom/pan should never do. The
    // repositioning it enabled wasn't even persistent (a released node
    // drifted back under the tier/link/collide forces within a tick or
    // two), so removing it costs nothing and makes every drag anywhere on
    // the canvas — including on top of a node — reliably pan instead.
    const zoom = d3.zoom().scaleExtent([0.35, 8]).on("zoom", (event) => zoomLayer.attr("transform", event.transform));
    svg.call(zoom);
    zoomRef.current = { zoom, svg, width, height };

    sim.on("tick", () => {
      linkSel.attr("x1", (d) => d.source.x).attr("y1", (d) => d.source.y).attr("x2", (d) => d.target.x).attr("y2", (d) => d.target.y);
      nodeSel.attr("transform", (d) => `translate(${d.x},${d.y})`);
    });

    nodeSelRef.current = nodeSel;
    return () => sim.stop();
  }, [nodes, scopedEdges, setFocal, tiered]);

  // Recolor without rebuilding the layout when the "color by" mode changes.
  useEffect(() => {
    const nodeSel = nodeSelRef.current;
    if (!nodeSel) return;
    nodeSel.select("rect, circle").attr("fill", (d) => debtColor(colorValueFor(d, colorBy)));
  }, [colorBy]);

  // Highlight pass — runs on selection change without rebuilding the graph.
  useEffect(() => {
    const nodeSel = nodeSelRef.current, linkSel = linkSelRef.current;
    if (!nodeSel || !linkSel) return;
    if (!focal) {
      nodeSel.attr("opacity", 1);
      linkSel.attr("opacity", (d) => baseEdgeOpacity(d, tiered)).attr("stroke-width", (d) => baseEdgeWidth(d, tiered));
      nodeSel.select("rect, circle").attr("stroke-width", 1.8);
      return;
    }
    const neighborIds = new Set([focal]);
    scopedEdges.forEach((e) => { if (e.source === focal) neighborIds.add(e.target); if (e.target === focal) neighborIds.add(e.source); });
    // Dimmed nodes stay legible (many DB schemas have lots of isolated
    // tables with no detected FK — a near-zero opacity here made the whole
    // graph look empty rather than "focused").
    nodeSel.attr("opacity", (d) => (neighborIds.has(d.id) ? 1 : 0.45));
    nodeSel.select("rect, circle").attr("stroke-width", (d) => (d.id === focal ? 3.5 : 1.8));
    linkSel
      .attr("opacity", (d) => (d.source.id === focal || d.target.id === focal ? 0.9 : 0.18))
      .attr("stroke-width", (d) => (d.source.id === focal || d.target.id === focal ? 2 : 1.2));
  }, [focal, scopedEdges, tiered]);

  useEffect(() => { setRecommendation({ forId: null, loading: false, text: "", error: false }); }, [focal]);
  useEffect(() => { setBlastRadius({ forId: null, loading: false, data: null, error: null, direction: "both" }); }, [focal]);

  // Pan/zoom to a node picked from search.
  function centerOn(id) {
    setFocal(id);
    const target = simNodesRef.current.find((n) => n.id === id);
    const zr = zoomRef.current;
    if (!target || !zr) return;
    const scale = 1.4;
    const t = d3.zoomIdentity.translate(zr.width / 2, zr.height / 2).scale(scale).translate(-target.x, -target.y);
    zr.svg.transition().duration(500).call(zr.zoom.transform, t);
  }

  if (nodes.length === 0) {
    return (
      <div style={{ background: "#F3F8FD", border: "1px dashed #C7DBEE", borderRadius: 12, padding: 40, textAlign: "center", color: "#5B7290", fontSize: 13.5 }}>
        {emptyLabel || "Nothing to show here yet."}
      </div>
    );
  }

  const focalNode = focal ? scopedNodesById[focal] : null;
  const outs = focal ? scopedEdges.filter((e) => e.source === focal).map((e) => scopedNodesById[e.target]).filter(Boolean) : [];
  const ins = focal ? scopedEdges.filter((e) => e.target === focal).map((e) => scopedNodesById[e.source]).filter(Boolean) : [];
  latestActionsRef.current = { getRecommendations, fetchBlastRadius };
  const allIds = Object.keys(scopedNodesById);
  const results = query.length > 1 ? allIds.filter((id) => id.toLowerCase().includes(query.toLowerCase())).slice(0, 8) : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 14, marginBottom: 10, flexWrap: "wrap" }}>
        <div style={{ position: "relative", maxWidth: 320, flex: 1 }}>
          <Search size={14} style={{ position: "absolute", left: 10, top: 10, color: "#93A7BF" }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Jump to a file or table…"
            style={{ width: "100%", boxSizing: "border-box", padding: "8px 10px 8px 30px", borderRadius: 8, border: "1px solid #C7DBEE", fontSize: 13, outline: "none" }} />
          {results.length > 0 && (
            <div style={{ position: "absolute", zIndex: 5, top: 36, left: 0, right: 0, background: "white", border: "1px solid #E1EBF5", borderRadius: 8, boxShadow: "0 8px 20px rgba(15,37,64,0.08)", maxHeight: 220, overflowY: "auto" }}>
              {results.map((id) => (
                <div key={id} onClick={() => { centerOn(id); setQuery(""); }}
                  style={{ padding: "8px 12px", fontSize: 12.5, fontFamily: "'IBM Plex Mono', monospace", cursor: "pointer", borderBottom: "1px solid #F0F5FA", display: "flex", justifyContent: "space-between" }}>
                  <span>{id}</span><span style={{ color: "#93A7BF" }}>{scopedNodesById[id]?.kind}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "#5B7290" }}>
          <Palette size={13} /> Color by:
          {COLOR_BY_OPTIONS.map(([key, label]) => (
            <button key={key} onClick={() => setColorBy(key)}
              style={{ fontSize: 11.5, fontWeight: 600, padding: "5px 10px", borderRadius: 7, cursor: "pointer", border: colorBy === key ? "1.5px solid #0EA5E9" : "1px solid #DCEAF6", background: colorBy === key ? "#E7F4FE" : "#FFFFFF", color: colorBy === key ? "#0369A1" : "#5B7290" }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {tiered && (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 10, padding: "9px 12px", background: "#F8FBFF", border: "1px solid #E1EBF5", borderRadius: 10 }}>
          <Workflow size={15} style={{ flexShrink: 0, marginTop: 1, color: "#0369A1" }} />
          <div style={{ fontSize: 11.5, color: "#3A4E68", lineHeight: 1.55 }}>
            <strong style={{ color: "#0F2540" }}>How to read this: </strong>
            nodes are placed along the request path your code actually follows — <strong>Frontend</strong> (user-facing / entry code) → <strong>Backend</strong> (business logic) → <strong>Database</strong> — so debt concentration is visible stage by stage, not just file by file. A run with no database connected shows only the tiers it actually analyzed. Bright, thicker edges cross a tier boundary — real inter-layer coupling; faint edges stay inside one tier and are dimmed on purpose so they don't drown out the flow. Start with whichever tier below carries the highest average debt, then click a node for its details, or double-click it to jump straight to its recommendations and blast radius.
          </div>
        </div>
      )}

      {tierSummary && (
        <div style={{ display: "flex", alignItems: "stretch", marginBottom: 10 }}>
          {tierSummary.map((t, i) => (
            <React.Fragment key={t.tier}>
              <div style={{ flex: 1, minWidth: 150, background: "#FFFFFF", border: "1px solid #E1EBF5", borderRadius: 10, padding: "10px 14px" }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 700, color: "#0F2540" }}>{TIER_LABELS[t.tier]}</span>
                  <span style={{ fontSize: 10.5, color: "#93A7BF" }}>{t.count} item{t.count === 1 ? "" : "s"}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1, height: 9, borderRadius: 5, background: "#EEF3F8", overflow: "hidden" }}>
                    <div style={{ width: `${Math.max(4, Math.round((t.avgDebt ?? 0) * 100))}%`, height: "100%", borderRadius: 5, background: t.avgDebt == null ? "#CBD5E1" : debtColor(t.avgDebt) }} />
                  </div>
                  <span style={{ fontSize: 13.5, fontWeight: 700, color: t.avgDebt == null ? "#93A7BF" : debtColor(t.avgDebt), minWidth: 32, textAlign: "right" }}>
                    {t.avgDebt == null ? "—" : t.avgDebt.toFixed(2)}
                  </span>
                </div>
                <div style={{ fontSize: 10, color: "#93A7BF", marginTop: 4, display: "flex", alignItems: "center" }}>
                  avg debt score <InfoIcon text={TIER_SCORE_INFO[t.tier]} size={11} />
                </div>
              </div>
              {i < tierSummary.length - 1 && (
                <div style={{ display: "flex", alignItems: "center", padding: "0 8px", color: "#B7CDE3" }}>
                  <ArrowRight size={20} />
                </div>
              )}
            </React.Fragment>
          ))}
        </div>
      )}

      {repoDbLinks && (
        <div style={{ marginBottom: 10, padding: "10px 12px", background: "#FBFDFF", border: "1px solid #E1EBF5", borderRadius: 10 }}>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: "#0F2540", marginBottom: 2 }}>Which repo talks to which database</div>
          <div style={{ fontSize: 10.5, color: "#93A7BF", marginBottom: 8 }}>Detected automatically from code-to-table references found during analysis — a count of real matches, not a guess.</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {repoDbLinks.perRepo.map(({ repo, links }) => (
              <div key={repo.slug} style={{ display: "flex", alignItems: "center", gap: 6, background: "#FFFFFF", border: "1px solid #E1EBF5", borderRadius: 9, padding: "6px 10px", fontSize: 11.5 }}>
                <GitBranch size={12} color="#5B7290" />
                <strong style={{ color: "#0F2540" }}>{repo.name}</strong>
                {links.length === 0 ? (
                  <span style={{ color: "#B45309" }}>→ no database reference detected</span>
                ) : (
                  <>
                    <ArrowRight size={12} color="#93A7BF" />
                    <span style={{ color: "#5B7290" }}>
                      {links.map((l) => `${l.name} (${l.tableCount} table${l.tableCount === 1 ? "" : "s"})`).join(", ")}
                    </span>
                  </>
                )}
              </div>
            ))}
            {repoDbLinks.orphanDbs.map((d) => (
              <div key={d.slug} style={{ display: "flex", alignItems: "center", gap: 6, background: "#FDECEC", border: "1px solid #F5C6C6", borderRadius: 9, padding: "6px 10px", fontSize: 11.5, color: "#9F1D1D" }}>
                <Database size={12} /> {d.name}: not referenced by any analyzed repo
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ position: "relative", flex: 1, background: "#FFFFFF", border: "1px solid #E1EBF5", borderRadius: 12, minHeight: 420, overflow: "hidden" }}>
        <svg ref={svgRef} width="100%" height="100%" style={{ display: "block" }} />

        {focalNode && (
          <div style={{ position: "absolute", top: 14, right: 14, width: 240, background: "rgba(255,255,255,0.97)", border: "1px solid #E1EBF5", borderRadius: 10, padding: 14, boxShadow: "0 8px 24px rgba(15,37,64,0.10)" }}>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: "#0F2540", fontWeight: 700, wordBreak: "break-all", marginBottom: 6 }}>{focal}</div>
            <div style={{ display: "inline-block", fontSize: 11, padding: "2px 7px", borderRadius: 99, background: debtColor(focalNode.debt_score ?? 0), color: textOnColor(debtColor(focalNode.debt_score ?? 0)), marginBottom: 10, fontWeight: 700 }}>
              debt {(focalNode.debt_score ?? 0).toFixed(2)}
            </div>
            {focalNode.flow_risks?.length > 0 && (
              <div style={{ marginBottom: 10, padding: "7px 9px", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, color: "#92400E", marginBottom: 5 }}>
                  <AlertTriangle size={12} /> {focalNode.flow_risks.length} flow risk{focalNode.flow_risks.length === 1 ? "" : "s"}
                </div>
                {focalNode.flow_risks.slice(0, 4).map((r, i) => (
                  <div key={i} style={{ fontSize: 10.5, color: "#78350F", marginBottom: 3, lineHeight: 1.4 }}>
                    L{r.line}: {r.label}
                  </div>
                ))}
                <div style={{ fontSize: 9.5, color: "#B45309", marginTop: 2 }}>A lead to check, not a certainty — a static pattern scan.</div>
              </div>
            )}
            {focalNode.chain_complexity && (
              <div style={{ marginBottom: 10, padding: "7px 9px", background: focalNode.chain_complexity.high_complexity ? "#FFFBEB" : "#F8FBFF", border: `1px solid ${focalNode.chain_complexity.high_complexity ? "#FDE68A" : "#E1EBF5"}`, borderRadius: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, color: focalNode.chain_complexity.high_complexity ? "#92400E" : "#0F2540" }}>
                  <Workflow size={12} />
                  {focalNode.chain_complexity.hops_to_frontend == null
                    ? "No frontend-reachable request chain found"
                    : `${focalNode.chain_complexity.hops_to_frontend} hop${focalNode.chain_complexity.hops_to_frontend === 1 ? "" : "s"} to frontend${focalNode.chain_complexity.high_complexity ? " — deep chain" : ""}`}
                </div>
              </div>
            )}
            <div style={{ fontSize: 11.5, color: "#5B7290", marginBottom: 4 }}>Depends on ({outs.length})</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
              {outs.slice(0, 6).map((f) => (
                <span key={f.id} onClick={() => centerOn(f.id)} style={{ fontSize: 10.5, fontFamily: "'IBM Plex Mono', monospace", background: "#F3F8FD", border: "1px solid #DCEAF6", borderRadius: 5, padding: "2px 5px", cursor: "pointer" }}>{shortName(f.id)}</span>
              ))}
              {outs.length === 0 && <span style={{ fontSize: 11, color: "#B7CDE3" }}>None</span>}
            </div>
            <div style={{ fontSize: 11.5, color: "#5B7290", marginBottom: 4 }}>Depended on by ({ins.length})</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10 }}>
              {ins.slice(0, 6).map((f) => (
                <span key={f.id} onClick={() => centerOn(f.id)} style={{ fontSize: 10.5, fontFamily: "'IBM Plex Mono', monospace", background: "#F3F8FD", border: "1px solid #DCEAF6", borderRadius: 5, padding: "2px 5px", cursor: "pointer" }}>{shortName(f.id)}</span>
              ))}
              {ins.length === 0 && <span style={{ fontSize: 11, color: "#B7CDE3" }}>None</span>}
            </div>
            <button onClick={() => getRecommendations(focalNode, outs, ins)} disabled={recommendation.loading}
              style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "8px 0", background: "#0EA5E9", color: "white", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", opacity: recommendation.loading ? 0.6 : 1, marginBottom: 6 }}>
              <Sparkles size={13} /> {recommendation.loading ? "Generating…" : "Get recommendations"}
            </button>
            <button onClick={() => fetchBlastRadius(focal, "both")} disabled={blastRadius.loading}
              title="What's upstream and downstream of this node, up to 3 hops out"
              style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "8px 0", background: "#FFFFFF", color: "#DB2777", border: "1px solid #F5B8D6", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", opacity: blastRadius.loading ? 0.6 : 1 }}>
              <Workflow size={13} /> {blastRadius.loading ? "Computing…" : "Blast radius"}
            </button>
          </div>
        )}

        {blastRadius.forId === focal && (blastRadius.data || blastRadius.error || blastRadius.loading) && (
          <div style={{ position: "absolute", bottom: 50, right: 14, width: 300, maxHeight: "calc(100% - 200px)", overflowY: "auto", background: "#FFFFFF", border: "1px solid #F5B8D6", borderRadius: 10, padding: 14, boxShadow: "0 12px 32px rgba(15,37,64,0.16)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: "#DB2777" }}><Workflow size={13} /> Blast radius: {shortName(focal)}</div>
              <button onClick={() => setBlastRadius({ forId: null, loading: false, data: null, error: null, direction: "both" })} style={{ background: "none", border: "none", cursor: "pointer", color: "#93A7BF" }}><X size={14} /></button>
            </div>
            <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
              {[["both", "Both"], ["upstream", "Upstream (relies on)"], ["downstream", "Downstream (relies on this)"]].map(([key, label]) => (
                <button key={key} onClick={() => fetchBlastRadius(focal, key)}
                  style={{ fontSize: 10, fontWeight: 600, padding: "4px 7px", borderRadius: 6, cursor: "pointer", border: blastRadius.direction === key ? "1.5px solid #DB2777" : "1px solid #E1EBF5", background: blastRadius.direction === key ? "#FCE7F3" : "#FFFFFF", color: blastRadius.direction === key ? "#DB2777" : "#5B7290" }}>
                  {label}
                </button>
              ))}
            </div>
            {blastRadius.loading && <div style={{ fontSize: 12.5, color: "#93A7BF" }}>Walking the dependency graph…</div>}
            {blastRadius.error && <div style={{ fontSize: 12.5, color: "#9F1D1D" }}>{blastRadius.error}</div>}
            {blastRadius.data && (
              <>
                <div style={{ display: "flex", gap: 10, marginBottom: 10, fontSize: 11, color: "#5B7290" }}>
                  <span><b style={{ color: "#0F2540" }}>{blastRadius.data.summary.total_affected}</b> affected</span>
                  <span><b style={{ color: "#DC2626" }}>{blastRadius.data.summary.high_debt_count}</b> high-debt</span>
                </div>
                {blastRadius.data.nodes.length === 0 ? (
                  <div style={{ fontSize: 11.5, color: "#93A7BF" }}>Nothing reachable in this direction within 3 hops.</div>
                ) : (
                  blastRadius.data.nodes.slice(0, 40).map((n) => (
                    <div key={n.id} onClick={() => n.kind !== "external" && centerOn(n.id)}
                      style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 0", borderBottom: "1px solid #F5F5FA", cursor: n.kind !== "external" ? "pointer" : "default" }}>
                      <span style={{ fontSize: 9.5, fontWeight: 700, color: "#93A7BF", width: 34, flexShrink: 0 }}>{n.hops}h {n.direction === "upstream" ? "↑" : "↓"}</span>
                      <span style={{ fontSize: 11, fontFamily: "'IBM Plex Mono', monospace", color: "#0F2540", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={n.id}>{shortName(n.id)}</span>
                      {n.debt_score != null && (
                        <span style={{ fontSize: 9.5, fontWeight: 700, color: textOnColor(debtColor(n.debt_score)), background: debtColor(n.debt_score), borderRadius: 99, padding: "1px 6px", flexShrink: 0 }}>{n.debt_score.toFixed(2)}</span>
                      )}
                      {isCouplingEdge(n.edge_type) && <span title={COUPLING_EDGE_LABELS[n.edge_type] || n.edge_type} style={{ fontSize: 9, color: COUPLING_EDGE_COLOR, flexShrink: 0 }}>⚡</span>}
                    </div>
                  ))
                )}
                {blastRadius.data.nodes.length > 40 && <div style={{ fontSize: 10.5, color: "#93A7BF", marginTop: 6 }}>…and {blastRadius.data.nodes.length - 40} more.</div>}
              </>
            )}
          </div>
        )}

        {recommendation.forId === focal && (recommendation.text || recommendation.loading) && (
          <div style={{ position: "absolute", top: 14, left: 14, width: 340, maxHeight: "calc(100% - 60px)", overflowY: "auto", background: "#FFFFFF", border: "1px solid #E1EBF5", borderRadius: 10, padding: 16, boxShadow: "0 12px 32px rgba(15,37,64,0.16)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: "#0369A1" }}><Sparkles size={13} /> Recommendations for {shortName(focal)}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                {!recommendation.loading && !recommendation.error && (
                  <div style={{ display: "flex", gap: 2 }}>
                    <button onClick={() => voteOnRecommendation("up")} title="Helpful recommendation"
                      style={{ background: "none", border: "none", cursor: "pointer", padding: 3, color: recVoted[focal] === "up" ? "#0EA5E9" : "#B7C4D6" }}>
                      <ThumbsUp size={13} />
                    </button>
                    <button onClick={() => voteOnRecommendation("down")} title="Not helpful"
                      style={{ background: "none", border: "none", cursor: "pointer", padding: 3, color: recVoted[focal] === "down" ? "#DC2626" : "#B7C4D6" }}>
                      <ThumbsDown size={13} />
                    </button>
                  </div>
                )}
                <button onClick={() => setRecommendation({ forId: null, loading: false, text: "", error: false, sources: [], kbQuery: "" })} style={{ background: "none", border: "none", cursor: "pointer", color: "#93A7BF" }}><X size={14} /></button>
              </div>
            </div>
            {recommendation.loading ? (
              <div style={{ fontSize: 12.5, color: "#93A7BF" }}>Thinking through the metrics…</div>
            ) : (
              <>
                <AnswerBlock text={recommendation.text} error={recommendation.error} />
                <KnowledgeSourcesPanel sources={recommendation.sources} query={recommendation.kbQuery} />
              </>
            )}
          </div>
        )}

        <div style={{ position: "absolute", bottom: 10, left: 12, display: "flex", gap: 14, fontSize: 10.5, color: "#7B8FA8", background: "rgba(255,255,255,0.9)", padding: "5px 10px", borderRadius: 8, flexWrap: "wrap", maxWidth: "calc(100% - 24px)" }}>
          <span>● circle = file</span>
          <span>▪ square = table</span>
          <span style={{ color: "#6366F1" }}>— foreign key</span>
          <span style={{ color: "#F59E0B" }}>┄ code → table</span>
          {edges.some((e) => isCouplingEdge(e.edge_type)) && <span style={{ color: COUPLING_EDGE_COLOR }}>┄ implicit runtime coupling (shared cache/queue/topic)</span>}
          {tiered && <span>bright/thick edge = crosses a tier · faint edge = stays within one</span>}
        </div>
      </div>
      <p style={{ fontSize: 12, color: "#93A7BF", marginTop: 8 }}>Scroll or pinch to zoom in on any point, drag anywhere to pan — click a node to focus it, click empty space to clear.</p>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Architecture tab — AI-authored module narratives (module_narrative.py)
// ---------------------------------------------------------------------------
function ModuleCard({ mod, onGenerate, generating }) {
  const [expanded, setExpanded] = useState(false);
  const hasNarrative = !!mod.narrative;
  return (
    <div style={{ background: "#FFFFFF", border: "1px solid #E1EBF5", borderRadius: 12, padding: 16, marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, fontWeight: 700, color: "#0F2540", wordBreak: "break-all" }}>{mod.module_id}</div>
          {hasNarrative && mod.narrative.role && <div style={{ fontSize: 12.5, color: "#5B7290", marginTop: 3 }}>{mod.narrative.role}</div>}
          <div style={{ display: "flex", gap: 12, marginTop: 8, fontSize: 11, color: "#93A7BF" }}>
            <span>{mod.file_count} file{mod.file_count === 1 ? "" : "s"}</span>
            <span>{mod.total_loc.toLocaleString()} loc</span>
            {mod.high_debt_count > 0 && <span style={{ color: "#DC2626", fontWeight: 600 }}>{mod.high_debt_count} high-debt</span>}
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 700, padding: "3px 9px", borderRadius: 99, background: debtColor(mod.avg_debt), color: textOnColor(debtColor(mod.avg_debt)) }}>
            avg {mod.avg_debt.toFixed(2)}
          </span>
          {mod.narrative_stale && hasNarrative && (
            <span title="This module's files/metrics changed since this narrative was generated" style={{ fontSize: 9.5, color: "#B45309", display: "flex", alignItems: "center", gap: 3 }}>
              <RotateCw size={9} /> stale
            </span>
          )}
        </div>
      </div>

      {hasNarrative && mod.narrative.priority_files?.length > 0 && (
        <div style={{ marginTop: 10, padding: "9px 11px", background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 9 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 700, color: "#92400E", marginBottom: 6 }}>
            <AlertTriangle size={12} /> Files needing immediate attention
          </div>
          {mod.narrative.priority_files.map((pf, i) => (
            <div key={i} style={{ marginBottom: i < mod.narrative.priority_files.length - 1 ? 8 : 0, fontSize: 11.5 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <span style={{ fontSize: 10, fontWeight: 700, color: "#B45309", flexShrink: 0 }}>{i + 1}.</span>
                <span style={{ fontFamily: "'IBM Plex Mono', monospace", fontWeight: 700, color: "#0F2540", wordBreak: "break-all" }}>{pf.file}</span>
              </div>
              {pf.reason && <div style={{ color: "#78350F", marginLeft: 16, marginTop: 1 }}>{pf.reason}</div>}
              {pf.recommendation && <div style={{ color: "#0369A1", marginLeft: 16, marginTop: 2, fontWeight: 600 }}>→ {pf.recommendation}</div>}
            </div>
          ))}
        </div>
      )}

      {mod.narrative_status === "error" && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: "#9F1D1D", background: "#FDECEC", border: "1px solid #F5C6C6", borderRadius: 7, padding: "6px 9px" }}>
          Narrative generation failed: {mod.narrative_error}
        </div>
      )}
      {mod.narrative_status === "running" && (
        <div style={{ marginTop: 10, fontSize: 11.5, color: "#93A7BF", display: "flex", alignItems: "center", gap: 6 }}>
          <Loader2 size={12} className="spin-dashboard" /> Generating narrative…
        </div>
      )}

      {hasNarrative && (
        <div style={{ marginTop: 10 }}>
          <button onClick={() => setExpanded((e) => !e)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 11.5, color: "#0369A1", fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
            <Info size={12} /> {expanded ? "Hide details" : "Responsibilities, key files, concerns & recommendations"}
          </button>
          {expanded && (
            <div style={{ marginTop: 8, fontSize: 12, color: "#3A4E68", lineHeight: 1.6 }}>
              {mod.narrative.recommendations?.length > 0 && (
                <div style={{ marginBottom: 8, padding: "8px 10px", background: "#F0F9FF", border: "1px solid #CDE9FB", borderRadius: 7 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 5, fontWeight: 700, color: "#0369A1", fontSize: 11 }}><Sparkles size={11} /> Recommendations</div>
                  <ol style={{ margin: "3px 0 0", paddingLeft: 18 }}>{mod.narrative.recommendations.map((r, i) => <li key={i} style={{ marginBottom: 3 }}>{r}</li>)}</ol>
                </div>
              )}
              {mod.narrative.responsibilities?.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontWeight: 700, color: "#0F2540", fontSize: 11 }}>Responsibilities</div>
                  <ul style={{ margin: "3px 0 0", paddingLeft: 18 }}>{mod.narrative.responsibilities.map((r, i) => <li key={i}>{r}</li>)}</ul>
                </div>
              )}
              {mod.narrative.key_files?.length > 0 && (
                <div style={{ marginBottom: 8 }}>
                  <div style={{ fontWeight: 700, color: "#0F2540", fontSize: 11 }}>Key files</div>
                  <ul style={{ margin: "3px 0 0", paddingLeft: 18 }}>{mod.narrative.key_files.map((r, i) => <li key={i} style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 11 }}>{r}</li>)}</ul>
                </div>
              )}
              {mod.narrative.concerns?.length > 0 && (
                <div>
                  <div style={{ fontWeight: 700, color: "#0F2540", fontSize: 11 }}>Concerns</div>
                  <ul style={{ margin: "3px 0 0", paddingLeft: 18 }}>{mod.narrative.concerns.map((r, i) => <li key={i}>{r}</li>)}</ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {(!hasNarrative || mod.narrative_stale) && mod.narrative_status !== "running" && (
        <button onClick={() => onGenerate(mod.module_id)} disabled={generating}
          style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", background: hasNarrative ? "#FFFFFF" : "#0EA5E9", color: hasNarrative ? "#0369A1" : "white", border: hasNarrative ? "1px solid #CDE9FB" : "none", borderRadius: 7, fontSize: 11.5, fontWeight: 600, cursor: "pointer", opacity: generating ? 0.6 : 1 }}>
          <Sparkles size={12} /> {hasNarrative ? "Regenerate narrative" : "Generate narrative"}
        </button>
      )}
    </div>
  );
}

function ArchitectureTab() {
  const [state, setState] = useState({ loading: true, modules: [], error: null });
  const [generating, setGenerating] = useState({}); // { [module_id]: true }
  const pollRef = useRef(null);

  async function load() {
    try {
      const res = await fetch("/api/modules");
      const json = await res.json();
      if (!json.ok && json.error) { setState({ loading: false, modules: [], error: json.error }); return; }
      setState({ loading: false, modules: json.modules || [], error: null });
    } catch {
      setState({ loading: false, modules: [], error: "Couldn't reach the server." });
    }
  }

  useEffect(() => {
    load();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  async function generate(moduleId) {
    setGenerating((g) => ({ ...g, [moduleId]: true }));
    try {
      await fetch("/api/modules/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ module_id: moduleId }) });
    } catch { /* surfaced via the module's own narrative_status on next poll */ }
    load();
    // Narrative generation is an LLM call running server-side in the
    // background — poll until this module (and any other still-running one)
    // settles, same pattern as the top-level analysis job's polling.
    if (pollRef.current) clearInterval(pollRef.current);
    let ticks = 0;
    pollRef.current = setInterval(async () => {
      ticks += 1;
      await load();
      if (ticks > 30) { clearInterval(pollRef.current); pollRef.current = null; } // ~60s safety stop
    }, 2000);
  }

  useEffect(() => {
    if (!state.modules.some((m) => m.narrative_status === "running")) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      setGenerating({});
    }
  }, [state.modules]);

  if (state.loading) return <div style={{ fontSize: 13, color: "#93A7BF", padding: 30 }}>Loading modules…</div>;
  if (state.error) return <div style={{ background: "#F3F8FD", border: "1px dashed #C7DBEE", borderRadius: 12, padding: 40, textAlign: "center", color: "#5B7290", fontSize: 13.5 }}>{state.error}</div>;
  if (state.modules.length === 0) return <div style={{ background: "#F3F8FD", border: "1px dashed #C7DBEE", borderRadius: 12, padding: 40, textAlign: "center", color: "#5B7290", fontSize: 13.5 }}>No modules found in the last analysis.</div>;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 14, padding: "9px 12px", background: "#F8FBFF", border: "1px solid #E1EBF5", borderRadius: 10 }}>
        <Boxes size={15} style={{ flexShrink: 0, marginTop: 1, color: "#0369A1" }} />
        <div style={{ fontSize: 11.5, color: "#3A4E68", lineHeight: 1.55 }}>
          Files grouped by folder, sorted by average debt. Narratives are generated on demand (they call the AI provider configured in Admin) and cached until that module's files or metrics change — click "Generate narrative" on any module you want a written summary for.
        </div>
      </div>
      {state.modules.map((mod) => (
        <ModuleCard key={mod.module_id} mod={mod} onGenerate={generate} generating={!!generating[mod.module_id] || mod.narrative_status === "running"} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reports tab — stored, itemized top-10 debt report (debt_report.py). The
// same question a user could already ask the Ask tab ("top 10 debt items
// and what to do about them"), made a first-class, persisted artifact.
// Confidence here is never the model's own self-rating — it's computed
// server-side from how much real evidence (findings, not just the debt
// score) backs each item, so it can't be hallucinated. See
// backend/debt_report.py for the full grounding/confidence logic.
// ---------------------------------------------------------------------------
function reportItemIcon(kind) { return kind === "table" ? Database : FileText; }

function ReportItemCard({ item, goToDeps }) {
  const [expanded, setExpanded] = useState(false);
  const c = confidenceColor(item.confidence_label);
  const Icon = reportItemIcon(item.kind);
  const evidenceCount = item.evidence_signals?.length || 0;
  return (
    <div style={{ background: "#FFFFFF", border: "1px solid #E1EBF5", borderRadius: 12, padding: 14, marginBottom: 10 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8, minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#93A7BF", flexShrink: 0, marginTop: 2 }}>#{item.rank}</span>
          <Icon size={14} color="#93A7BF" style={{ flexShrink: 0, marginTop: 2 }} />
          <button onClick={() => goToDeps?.(item.node_id)} title="View in dependency flow"
            style={{ background: "none", border: "none", padding: 0, cursor: goToDeps ? "pointer" : "default", textAlign: "left", fontFamily: "'IBM Plex Mono', monospace", fontSize: 12.5, fontWeight: 700, color: "#0F2540", wordBreak: "break-all" }}>
            {item.node_id}
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5, flexShrink: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 700, padding: "3px 9px", borderRadius: 99, background: debtColor(item.debt_score), color: textOnColor(debtColor(item.debt_score)) }}>
            {(item.debt_score || 0).toFixed(2)}
          </span>
          <span title="Computed from how many real, specific findings back this item — never the model's own self-rating" style={{ fontSize: 9.5, fontWeight: 700, color: c.fg, background: c.bg, padding: "1px 7px", borderRadius: 99, whiteSpace: "nowrap" }}>
            {item.confidence_label} confidence ({Math.round((item.confidence_score || 0) * 100)}%)
          </span>
        </div>
      </div>

      {item.issue_summary && <div style={{ fontSize: 12.5, color: "#3A4E68", marginTop: 8, lineHeight: 1.5 }}>{item.issue_summary}</div>}

      {item.recommendations?.length > 0 && (
        <div style={{ marginTop: 8, padding: "8px 10px", background: "#F0F9FF", border: "1px solid #CDE9FB", borderRadius: 7 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 5, fontWeight: 700, color: "#0369A1", fontSize: 11 }}><Sparkles size={11} /> Recommendations</div>
          <ol style={{ margin: "3px 0 0", paddingLeft: 18 }}>
            {item.recommendations.map((r, i) => <li key={i} style={{ marginBottom: 3, fontSize: 12, color: "#0F2540" }}>{r}</li>)}
          </ol>
        </div>
      )}

      <button onClick={() => setExpanded((e) => !e)} style={{ marginTop: 8, background: "none", border: "none", padding: 0, cursor: "pointer", fontSize: 11, color: "#5B7290", fontWeight: 600, display: "flex", alignItems: "center", gap: 4 }}>
        <Info size={11} /> {expanded ? "Hide grounding" : `Grounding (${evidenceCount} finding${evidenceCount === 1 ? "" : "s"}${item.kb_refs?.length ? `, ${item.kb_refs.length} reference${item.kb_refs.length === 1 ? "" : "s"}` : ""})`}
      </button>
      {expanded && (
        <div style={{ marginTop: 6, fontSize: 11.5, color: "#5B7290", lineHeight: 1.6 }}>
          {evidenceCount > 0 ? (
            <ul style={{ margin: 0, paddingLeft: 18 }}>{item.evidence_signals.map((s, i) => <li key={i}>{s}</li>)}</ul>
          ) : (
            <div style={{ fontStyle: "italic" }}>No specific finding beyond the debt score itself — that's why this item's confidence is Low.</div>
          )}
          {item.kb_refs?.length > 0 && <div style={{ marginTop: 4 }}>Cited reference material: {item.kb_refs.join(", ")}</div>}
        </div>
      )}
    </div>
  );
}

function ReportsTab({ goToDeps }) {
  const [reports, setReports] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [loadingList, setLoadingList] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState(null);
  const [retrying, setRetrying] = useState(false);
  const pollRef = useRef(null);

  async function loadList(selectLatest) {
    try {
      // no-store: this list is polled/re-fetched on every load and retry, and
      // without it the browser can serve a stale (or, worse, a broken/
      // truncated) cached response instead of ever asking the backend again —
      // which is exactly what made the Retry button look like a no-op.
      const res = await fetch("/api/reports", { cache: "no-store" });
      const json = await res.json();
      const list = json.reports || [];
      setReports(list);
      if (selectLatest && list.length > 0) setSelectedId(list[0].report_id);
      setLoadingList(false);
      setError(null); // a later successful load clears an earlier transient failure
    } catch {
      setLoadingList(false);
      setError("Couldn't reach the server.");
      return false;
    }
    return true;
  }

  // Wraps loadList with a visible "Retrying…" state so a click on the Retry
  // link always shows *something* happened, whether the backend answers
  // this time or fails again with the same message (which otherwise renders
  // identically to the click doing nothing at all).
  async function retryNow() {
    setRetrying(true);
    await loadList(true);
    setRetrying(false);
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ok = await loadList(true);
      // The single most common cause of this failing on first load: the page
      // was opened (or reloaded) in the brief window right after the backend
      // was restarted, before it finished binding its port. One silent
      // retry a moment later smooths over exactly that race instead of
      // leaving a stale, alarming error up for a backend that's actually
      // fine by the time anyone reads the message.
      if (!ok && !cancelled) {
        await new Promise((r) => setTimeout(r, 1500));
        if (!cancelled) loadList(true);
      }
    })();
    return () => { cancelled = true; if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  async function loadDetail(id) {
    try {
      const res = await fetch(`/api/reports/${id}`, { cache: "no-store" });
      if (!res.ok) { setDetail(null); return null; }
      const json = await res.json();
      setDetail(json);
      return json;
    } catch {
      setDetail(null);
      return null;
    }
  }

  useEffect(() => { if (selectedId != null) loadDetail(selectedId); }, [selectedId]);

  function pollUntilDone(id) {
    if (pollRef.current) clearInterval(pollRef.current);
    let ticks = 0;
    pollRef.current = setInterval(async () => {
      ticks += 1;
      const json = await loadDetail(id);
      if (json && json.status !== "running") {
        clearInterval(pollRef.current); pollRef.current = null;
        setGenerating(false);
        loadList(false);
      }
      if (ticks > 40) { clearInterval(pollRef.current); pollRef.current = null; setGenerating(false); } // ~80s safety stop
    }, 2000);
  }

  async function generate() {
    setGenerating(true);
    setError(null);
    // Clear any previously-loaded report before starting a new attempt —
    // otherwise a fresh failure (e.g. the server was mid-restart) renders
    // its error banner stacked on top of a stale, unrelated report from
    // before, which reads as one confusing, self-contradictory result.
    setDetail(null);
    try {
      const res = await fetch("/api/reports/generate", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ n: 10 }),
      });
      const json = await res.json();
      if (!json.ok) { setGenerating(false); setError(json.error || "Couldn't generate a report."); return; }
      setSelectedId(json.report_id);
      pollUntilDone(json.report_id);
    } catch {
      setGenerating(false);
      setError("Couldn't reach the server.");
    }
  }

  if (loadingList) return <div style={{ fontSize: 13, color: "#93A7BF", padding: 30 }}>Loading reports…</div>;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "9px 12px", background: "#F8FBFF", border: "1px solid #E1EBF5", borderRadius: 10, flex: 1, minWidth: 260 }}>
          <ClipboardList size={15} style={{ flexShrink: 0, marginTop: 1, color: "#0369A1" }} />
          <div style={{ fontSize: 11.5, color: "#3A4E68", lineHeight: 1.55 }}>
            The top 10 highest-debt items in the latest run, each with grounded recommendations and a confidence score computed from the real findings behind it — never the model's own self-rating. The same thing you could ask the Ask tab for, itemized and saved so past runs stay comparable.
          </div>
        </div>
        <button onClick={generate} disabled={generating}
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 14px", background: generating ? "#F3F8FD" : "#0EA5E9", color: generating ? "#93A7BF" : "white", border: "none", borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: generating ? "default" : "pointer", flexShrink: 0, whiteSpace: "nowrap" }}>
          {generating ? <Loader2 size={13} className="spin-dashboard" /> : <Sparkles size={13} />} {generating ? "Generating…" : "Generate report"}
        </button>
      </div>

      {error && (
        <div style={{ marginBottom: 12, fontSize: 12, color: "#9F1D1D", background: "#FDECEC", border: "1px solid #F5C6C6", borderRadius: 8, padding: "8px 12px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <span>{error}</span>
          <button onClick={retryNow} disabled={retrying} style={{ background: "none", border: "none", padding: 0, cursor: retrying ? "default" : "pointer", fontSize: 12, color: "#9F1D1D", fontWeight: 700, textDecoration: retrying ? "none" : "underline", opacity: retrying ? 0.6 : 1, flexShrink: 0 }}>{retrying ? "Retrying…" : "Retry"}</button>
        </div>
      )}

      {reports.length > 1 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, fontSize: 12 }}>
          <span style={{ color: "#5B7290" }}>Report:</span>
          <select value={selectedId ?? ""} onChange={(e) => setSelectedId(Number(e.target.value))}
            style={{ fontSize: 12, padding: "5px 8px", borderRadius: 7, border: "1px solid #E1EBF5", color: "#0F2540" }}>
            {reports.map((r, i) => (
              <option key={r.report_id} value={r.report_id}>
                {timeAgo(r.created_at)}{r.run_id != null ? ` · run ${r.run_id}` : ""} · {r.status}{i === 0 ? " (latest)" : ""}
              </option>
            ))}
          </select>
        </div>
      )}

      {reports.length === 0 && (
        <div style={{ background: "#F3F8FD", border: "1px dashed #C7DBEE", borderRadius: 12, padding: 40, textAlign: "center", color: "#5B7290", fontSize: 13.5 }}>
          No report yet. Click "Generate report" to rank the latest run's top 10 debt items with grounded recommendations.
        </div>
      )}

      {detail && detail.status === "running" && (
        <div style={{ fontSize: 12.5, color: "#93A7BF", display: "flex", alignItems: "center", gap: 6, padding: 30, justifyContent: "center" }}>
          <Loader2 size={13} className="spin-dashboard" /> Generating…
        </div>
      )}
      {detail && detail.status === "error" && (
        <div style={{ fontSize: 12.5, color: "#9F1D1D", background: "#FDECEC", border: "1px solid #F5C6C6", borderRadius: 8, padding: "10px 14px" }}>
          Report generation failed: {detail.error}
        </div>
      )}
      {detail && detail.status === "done" && (
        <div>
          <div style={{ fontSize: 11, color: "#93A7BF", marginBottom: 10 }}>
            Generated {timeAgo(detail.created_at)}{detail.run_id != null ? ` from run ${detail.run_id}` : ""} · {detail.provider}/{detail.model}
          </div>
          {detail.items.map((item) => <ReportItemCard key={item.node_id} item={item} goToDeps={goToDeps} />)}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat / guidance tab
// ---------------------------------------------------------------------------
const SAMPLE_QUESTIONS = [
  "Which file is riskiest to touch before a release?",
  "Which database table has the most debt, and why?",
  "Where should the team focus refactoring effort first?",
];

function codebaseTechLine(data) {
  if (data.repos?.length > 1) {
    return data.repos.map((r) => `${r.name} (${codeLangsLabel(r.code_langs, r.frameworks)})`).join(", ");
  }
  return codeLangsDescription(data.code_langs, data.frameworks);
}

function databaseLine(data) {
  if (data.databases?.length > 1) {
    return data.databases.map((d) => `${d.name} (${DB_DIALECT_LABELS[d.dialect] || d.dialect})`).join(", ");
  }
  return data.db_dialect ? DB_DIALECT_LABELS[data.db_dialect] || data.db_dialect : null;
}

function buildExternalContextSection(data) {
  const entries = data.external_context || [];
  if (!entries.length) return "";
  const rendered = entries.map((c) => (
    c.ok
      ? `### ${c.kind === "jira" ? "Jira" : "Confluence"}: ${c.title || c.url}\n${c.text}`
      : `(${c.kind === "jira" ? "Jira" : "Confluence"} fetch for ${c.url} failed: ${c.error})`
  ));
  return `\nProject context from Jira/Confluence:\n${rendered.join("\n\n")}\n`;
}

function buildContext(data) {
  const topFiles = [...data.files].sort((a, b) => b.debt_score - a.debt_score).slice(0, 12);
  const topTables = [...(data.tables || [])].sort((a, b) => b.debt_score - a.debt_score).slice(0, 8);
  const dbLine = databaseLine(data);
  return `Repository: ${data.repo}
Codebase tech: ${codebaseTechLine(data)}${dbLine ? ` | Database: ${dbLine}` : ""}
Metrics last computed: ${data.generated_at}
Files: ${data.summary.total_files} | Tables: ${data.summary.total_tables} | Edges: ${data.summary.total_edges} | Avg code debt: ${data.summary.avg_code_debt} | Avg DB debt: ${data.summary.avg_db_debt}

Code debt_score = 35% complexity + 20% churn + 25% security (static analysis findings) + 20% design (maintainability index, long functions, deep nesting, too many params, oversized files, duplicate/near-duplicate code, high public surface, long if/switch chains).
DB debt_score = 30% performance (unindexed FKs) + 15% size + 30% security (sensitive columns, broad write grants) + 25% design (missing PK, unenforced *_id relationships, table width).
${buildExternalContextSection(data)}
Top files by debt score:
${topFiles.map((f) => `- ${f.file}${f.repo ? ` [repo: ${f.repo}]` : ""} | debt=${f.debt_score} (complexity=${f.score_breakdown?.complexity}, churn=${f.score_breakdown?.churn}, security=${f.score_breakdown?.security}, design=${f.score_breakdown?.design}) | avg_complexity=${f.avg_complexity} | churn=${f.churn} | security_issues=${f.security_issue_count}(${f.security_high_count} high) | duplicate_functions=${f.duplicate_function_count ?? 0} | long_conditional_chains=${f.long_conditional_chain_count ?? 0} | fan_in=${f.fan_in}`).join("\n")}
${topTables.length ? `\nTop DB tables by debt score:\n${topTables.map((t) => `- ${t.file}${t.db ? ` [db: ${t.db}]` : ""} | debt=${t.debt_score} (performance=${t.score_breakdown?.performance}, security=${t.score_breakdown?.security}, design=${t.score_breakdown?.design}) | rows=${t.row_estimate ?? "unknown"} | missing_indexed_fks=${t.missing_indexed_fks ?? "unknown"} | high_risk_columns=${(t.high_risk_columns||[]).join(",") || "none"} | missing_pk=${t.missing_primary_key} | fk_in=${t.fk_in}`).join("\n")}` : ""}
`;
}

// buildContext() above only ever includes the top 12 files / top 8 tables by
// debt score — a real cross-layer summary, but it can miss the exact item a
// question is actually about (a file ranked #40, or a table with no debt
// concerns at all but a question about its schema). findMentionedNodes scans
// the user's question text for a file/table this analysis actually knows
// about, so `send()` below can fetch its real source (same /api/file-source
// endpoint the graph's "Get recommendations" already uses) and full metrics
// and inject them just for this question — code-in-context grounding keyed
// to what the user actually asked, on top of the always-present summary.
function findMentionedNodes(text, data, maxMatches = 2) {
  if (!text) return [];
  const lower = text.toLowerCase();
  const candidates = [...(data.files || []), ...(data.tables || [])];
  const scored = [];
  for (const n of candidates) {
    const id = n.file || n.id;
    if (!id) continue;
    const base = shortName(id);
    let score = 0;
    if (lower.includes(id.toLowerCase())) score = 3;               // full path/id mentioned
    else if (base.length > 3 && lower.includes(base.toLowerCase())) score = 2; // bare filename/table mentioned
    else if (n.bare_name && n.bare_name.length > 3 && lower.includes(n.bare_name.toLowerCase())) score = 2;
    if (score > 0) scored.push({ node: n, score });
  }
  scored.sort((a, b) => b.score - a.score || (b.node.debt_score ?? 0) - (a.node.debt_score ?? 0));
  return scored.slice(0, maxMatches).map((s) => s.node);
}

function describeMentionedNode(node, edges) {
  const isTable = node.kind === "table";
  const id = node.file || node.id;
  const outs = (edges || []).filter((e) => e.source === id).map((e) => e.target);
  const ins = (edges || []).filter((e) => e.target === id).map((e) => e.source);
  const lines = [`Item: ${id} (${isTable ? "database table" : "code file"})`, `Debt score: ${node.debt_score}`];
  if (!isTable) {
    lines.push(`Avg complexity: ${node.avg_complexity} | Max complexity: ${node.max_complexity} | Maintainability index: ${node.maintainability_index}`);
    lines.push(`Churn (2yr commits): ${node.churn} | Long functions: ${node.long_function_count} | Max nesting depth: ${node.max_nesting_depth} | God file: ${node.god_file}`);
    if (node.security_issue_count > 0) {
      lines.push(`Security findings (${node.security_issue_count}, ${node.security_high_count} high):`);
      (node.security_issues || []).forEach((iss) => lines.push(`  - [${iss.severity}] ${iss.test_id}: ${iss.text} (line ${iss.line})`));
    }
    if (node.flow_risks?.length) {
      lines.push(`Flow/concurrency risks (${node.flow_risks.length}, static pattern scan — a lead to check, not a certainty):`);
      node.flow_risks.forEach((r) => lines.push(`  - L${r.line}: ${r.label} — ${r.detail}`));
    }
  } else {
    lines.push(`Rows: ${node.row_estimate ?? "unknown"} | Columns: ${node.column_count} | Missing indexed FKs: ${node.missing_indexed_fks ?? "unknown"}`);
    if (node.high_risk_columns?.length) lines.push(`High-risk columns exposed: ${node.high_risk_columns.join(", ")}`);
    if (node.missing_primary_key) lines.push("No primary key declared.");
    if (node.unenforced_relationships?.length) lines.push(`Columns that look like foreign keys but aren't enforced: ${node.unenforced_relationships.join(", ")}`);
    if (node.chain_complexity) {
      lines.push(`Request-chain hops back to frontend: ${node.chain_complexity.hops_to_frontend ?? "not reachable from an analyzed frontend"}${node.chain_complexity.high_complexity ? " (unusually deep)" : ""}`);
    }
  }
  lines.push(`Depends on: ${outs.join(", ") || "none"}`);
  lines.push(`Depended on by: ${ins.join(", ") || "none"}`);
  return lines.join("\n");
}

async function buildMentionedItemsSection(text, data) {
  const nodes = findMentionedNodes(text, data);
  if (!nodes.length) return "";
  const parts = await Promise.all(nodes.map(async (n) => {
    const detail = describeMentionedNode(n, data.edges);
    if (n.kind === "table") return detail;
    try {
      const srcRes = await fetch(`/api/file-source?id=${encodeURIComponent(n.file || n.id)}`);
      const srcJson = await srcRes.json();
      if (srcJson.ok) {
        return `${detail}\n\nFull source${srcJson.truncated ? " (truncated)" : ""}:\n\`\`\`\n${srcJson.source}\n\`\`\``;
      }
    } catch {
      // no source available (e.g. re-analyzed elsewhere since) — the metrics detail above still grounds the answer
    }
    return detail;
  }));
  const hasSource = nodes.some((n) => n.kind !== "table");
  return `\n\nYour question appears to reference specific item(s) this analysis knows about — real metrics${hasSource ? " and source code" : ""} fetched for grounding, beyond the top-debt summary above:\n\n${parts.join("\n\n---\n\n")}`;
}


function MarkdownBlock({ text, error }) {
  if (error) return <div style={{ fontSize: 13, color: "#9F1D1D" }}>{text}</div>;
  return (
    <div style={{ fontSize: 13, lineHeight: 1.65, color: "#1E2E42" }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: (p) => <div style={{ fontSize: 15, fontWeight: 700, margin: "10px 0 6px", color: "#0F2540" }} {...p} />,
          h2: (p) => <div style={{ fontSize: 13.5, fontWeight: 700, margin: "14px 0 7px", color: "#0369A1", borderBottom: "1px solid #E1EBF5", paddingBottom: 5 }} {...p} />,
          h3: (p) => <div style={{ fontSize: 12.5, fontWeight: 700, margin: "10px 0 4px", color: "#0F2540" }} {...p} />,
          p: (p) => <p style={{ margin: "6px 0" }} {...p} />,
          ul: (p) => <ul style={{ margin: "4px 0 10px", paddingLeft: 20 }} {...p} />,
          ol: (p) => <ol style={{ margin: "4px 0 10px", paddingLeft: 20 }} {...p} />,
          li: (p) => <li style={{ marginBottom: 5 }} {...p} />,
          strong: (p) => <strong style={{ color: "#0F2540", fontWeight: 700 }} {...p} />,
          code: ({ className, children, ...p }) => {
            const isBlock = /language-/.test(className || "") || String(children).includes("\n");
            return isBlock ? (
              <code style={{ display: "block", background: "#0F2540", color: "#EAF2FB", padding: 10, borderRadius: 8, fontFamily: "'IBM Plex Mono', monospace", fontSize: 11.5, overflowX: "auto", margin: "6px 0" }} {...p}>{children}</code>
            ) : (
              <code style={{ background: "#F0F5FA", padding: "1.5px 5px", borderRadius: 4, fontFamily: "'IBM Plex Mono', monospace", fontSize: "0.92em" }} {...p}>{children}</code>
            );
          },
          table: (p) => <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12, margin: "8px 0" }} {...p} />,
          th: (p) => <th style={{ border: "1px solid #E1EBF5", padding: "5px 8px", background: "#F3F8FD", textAlign: "left" }} {...p} />,
          td: (p) => <td style={{ border: "1px solid #E1EBF5", padding: "5px 8px" }} {...p} />,
          hr: () => <hr style={{ border: "none", borderTop: "1px solid #E1EBF5", margin: "12px 0" }} />,
          blockquote: (p) => <blockquote style={{ borderLeft: "3px solid #C7DBEE", paddingLeft: 10, color: "#5B7290", margin: "6px 0" }} {...p} />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

const CONFIDENCE_STYLE = {
  High: ["#0F7B4E", "#E7F9F1"],
  Medium: ["#B45309", "#FEF3E2"],
  Low: ["#9F1D1D", "#FDECEC"],
};

function parseConfidence(text) {
  const match = text.match(/\*\*Confidence:\s*(High|Medium|Low)\*\*\s*[—-]\s*(.+?)\s*$/im);
  if (!match) return { body: text, confidence: null, reason: null };
  return { body: (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim(), confidence: match[1], reason: match[2].trim() };
}

function ConfidenceBadge({ level, reason }) {
  const [fg, bg] = CONFIDENCE_STYLE[level] || CONFIDENCE_STYLE.Medium;
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: bg, color: fg, fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 99, marginTop: 6 }}>
      <ShieldAlert size={11} /> Confidence: {level}
      {reason && <span style={{ fontWeight: 400, opacity: 0.85 }}>— {reason}</span>}
    </div>
  );
}

// The system prompt now asks for a High/Medium/Low confidence tag inline on
// each individual fix/finding (see PER_ITEM_CONFIDENCE_INSTRUCTION) so it
// stays traceable to the specific claim it covers, rather than one blanket
// tag for a whole multi-item answer — those render naturally as part of the
// markdown body below, no extraction needed. parseConfidence only still
// matches the older single-trailing-line form, for the rare short answer
// that makes just one claim and never adopted the per-item shape; when it
// doesn't match (the common case now), this simply renders the body as-is.
function AnswerBlock({ text, error }) {
  if (error) return <div style={{ fontSize: 13, color: "#9F1D1D" }}>{text}</div>;
  const { body, confidence, reason } = parseConfidence(text);
  return (
    <div>
      <MarkdownBlock text={body} error={false} />
      {confidence && <ConfidenceBadge level={confidence} reason={reason} />}
    </div>
  );
}

function ChatTab({ data }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState({});
  const [recentDownvotes, setRecentDownvotes] = useState([]);
  const scrollRef = useRef(null);
  const context = useMemo(() => buildContext(data), [data]);

  useEffect(() => { loadFeedback().then(setFeedback); }, []);
  useEffect(() => {
    fetch("/api/feedback/recent?vote=down&limit=5").then((r) => r.json()).then((d) => setRecentDownvotes(d.items || [])).catch(() => {});
  }, []);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [messages, loading]);

  async function send(text) {
    if (!text.trim() || loading) return;
    const userMsg = { role: "user", content: text };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setLoading(true);
    try {
      // In-context feedback conditioning: recent down-voted answers are
      // shown as examples to avoid repeating. This is NOT gradient-based
      // reinforcement learning — no weights are updated — but it is a real,
      // functioning loop: today's thumbs-down measurably change tomorrow's
      // prompt, every time this tab loads.
      const feedbackNote = recentDownvotes.length
        ? `\n\nThe team has previously down-voted these answers as unhelpful — avoid repeating the same mistakes (vague claims, missing specifics, ignoring a relevant metric):\n${recentDownvotes.map((f, i) => `${i + 1}. Q: "${f.question}" — the down-voted answer was: "${f.answer.slice(0, 200)}..."`).join("\n")}`
        : "";

      const kbSources = await searchKnowledgeBase(text);
      const kbSection = kbSources.length
        ? `\n\nReference material retrieved from the team's knowledge base (cite by its [KB-...] tag when you use it — don't invent a citation for anything not listed here):\n${kbSources.map((s) => `[KB-${s.chunk_id}] ${s.filename}${s.page ? ` (p.${s.page})` : ""}: ${s.text}`).join("\n\n")}`
        : "";
      const kbInstruction = kbSources.length
        ? "\n\nReference material relevant to this question is included below, each tagged [KB-<id>]."
        : "";

      // Query-aware grounding: if the question names a specific file/table
      // this analysis knows about, fetch its real source and full metrics
      // (not just whatever made the top-12/top-8 summary) so the answer can
      // be specific to it, the same way "Get recommendations" already
      // grounds itself in a focal node's real source.
      const mentionedSection = await buildMentionedItemsSection(text, data);

      const res = await fetch(CHAT_API_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Same headroom reasoning as getRecommendations(): this system prompt
          // explicitly asks for a thorough, multi-section answer, and a tight
          // cap risks the model spending its whole budget on internal
          // reasoning before writing any visible text at all. A demanding ask
          // (e.g. a "top 10 fixes" breakdown with a per-item confidence tag
          // and citation on each one) can genuinely need this much — confirmed
          // via direct testing that 8192 still truncated a real "top 10 fixes"
          // answer before any items were written, while both Claude and
          // Gemini accepted 16384 without complaint and completed cleanly.
          max_tokens: 16384,
          system: `You are the guidance layer of an engineering-debt dashboard for an engineering team. Answer ONLY using the metrics data below — never invent numbers, files, or tables that aren't listed, and never fabricate a business-impact estimate (dollars, hours saved, risk %) that isn't derivable from the data. Reference specific paths/tables and their actual values, including which score component (complexity/churn/security/design, or performance/security/design for tables) is driving the concern. If the question names a specific file or table this analysis knows about, its real source code and/or full metrics (including any flow-risk or request-chain-complexity findings) are fetched fresh and included in a dedicated section below the summary — use those over the summary numbers for that item, since the summary only ever lists the top 12 files / top 8 tables by debt score and can omit the exact item asked about.

Format every answer in markdown with clear sections appropriate to the question — typically a short summary line, then '## '-headed sections such as findings, root causes, and recommendations. Be thorough and specific rather than terse: this is a working reference the team will read carefully, not a one-line reply. Still avoid padding — every sentence should carry real information from the data.

${PER_ITEM_CONFIDENCE_INSTRUCTION}${feedbackNote}${kbInstruction}\n\n${context}${mentionedSection}${kbSection}`,
          messages: [...messages, userMsg].map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      const json = await res.json();
      const textOut = (json.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n") || "No response.";
      const mentioned = [...data.files, ...(data.tables || [])].filter((f) => textOut.includes(shortName(f.file))).length;
      // When the provider call itself failed (json.error), nothing was
      // actually grounded in the retrieved sources — showing them next to an
      // error message would look like citations for an answer that doesn't exist.
      setMessages((m) => [...m, { role: "assistant", content: textOut, question: text, matched: mentioned, id: Date.now(), error: !!json.error, sources: json.error ? [] : kbSources, kbQuery: text }]);
      if (!json.error) {
        logChatExchange({ runId: data.run_id, kind: "chat", question: text, answer: textOut, kbQuery: text, sources: kbSources });
      }
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", content: "Couldn't reach the guidance model — check Admin settings for a valid API key.", error: true, id: Date.now(), sources: [] }]);
    }
    setLoading(false);
  }

  async function vote(msg, dir) {
    const next = { ...feedback, [msg.id]: dir };
    setFeedback(next);
    await saveFeedback(next);
    try {
      await fetch("/api/feedback", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: msg.question || "", answer: msg.content, vote: dir }),
      });
      if (dir === "down") {
        fetch("/api/feedback/recent?vote=down&limit=5").then((r) => r.json()).then((d) => setRecentDownvotes(d.items || []));
      }
    } catch (e) { /* feedback persistence is best-effort */ }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", background: "#FFFFFF", border: "1px solid #E1EBF5", borderRadius: 12, padding: 18, display: "flex", flexDirection: "column", gap: 14 }}>
        {messages.length === 0 && (
          <div>
            <p style={{ fontSize: 13, color: "#5B7290", marginTop: 0 }}>Ask about the debt, dependency, or churn data above. Try:</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {SAMPLE_QUESTIONS.map((q) => (
                <button key={q} onClick={() => send(q)} style={{ textAlign: "left", padding: "9px 12px", background: "#F3F8FD", border: "1px solid #DCEAF6", borderRadius: 8, fontSize: 13, color: "#0F2540", cursor: "pointer" }}>{q}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: m.role === "user" ? "78%" : "94%" }}>
            {m.role === "user" ? (
              <div style={{ padding: "10px 14px", borderRadius: 12, background: "#0EA5E9", color: "white", fontSize: 13.5, lineHeight: 1.5 }}>{m.content}</div>
            ) : (
              <div style={{ padding: "12px 16px", borderRadius: 12, background: m.error ? "#FDECEC" : "#F3F8FD", color: "#0F2540" }}>
                <AnswerBlock text={m.content} error={m.error} />
                <KnowledgeSourcesPanel sources={m.sources} query={m.kbQuery} />
              </div>
            )}
            {m.role === "assistant" && !m.error && (
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 5, fontSize: 11, color: "#93A7BF" }}>
                <Clock size={11} /> <span>data from {timeAgo(data.generated_at)}</span>
                <span>· grounded in {m.matched} referenced item{m.matched === 1 ? "" : "s"}</span>
                <button onClick={() => vote(m, "up")} style={{ background: "none", border: "none", cursor: "pointer", color: feedback[m.id] === "up" ? "#0EA5E9" : "#B7CDE3" }}><ThumbsUp size={13} /></button>
                <button onClick={() => vote(m, "down")} style={{ background: "none", border: "none", cursor: "pointer", color: feedback[m.id] === "down" ? "#DC2626" : "#B7CDE3" }}><ThumbsDown size={13} /></button>
              </div>
            )}
          </div>
        ))}
        {loading && <div style={{ fontSize: 12.5, color: "#93A7BF" }}>Thinking…</div>}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send(input)}
          placeholder="Ask about debt, churn, or dependencies…" style={{ flex: 1, padding: "10px 14px", borderRadius: 10, border: "1px solid #C7DBEE", fontSize: 13.5, outline: "none" }} />
        <button onClick={() => send(input)} disabled={loading}
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 16px", background: "#0EA5E9", color: "white", border: "none", borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: "pointer", opacity: loading ? 0.6 : 1 }}>
          <Send size={14} /> Ask
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------
export default function Dashboard({ data, onReanalyze, jobRunning, jobStep, jobError, justCompleted, onDismissComplete, onDismissError }) {
  const hasDb = data.has_db && data.tables && data.tables.length > 0;
  const [tab, setTab] = useState("heat");
  const [selectedFile, setSelectedFile] = useState(null);
  const [selectedTable, setSelectedTable] = useState(null);
  const [showAdmin, setShowAdmin] = useState(false);
  // Start unfocused: pre-selecting the highest-debt node made every graph
  // look dimmed/near-empty on first load, before the user clicked anything —
  // especially bad for schemas with lots of isolated tables.
  const [focal, setFocal] = useState(null);

  const nodesById = useMemo(() => {
    const m = {};
    for (const f of data.files) m[f.file] = { ...f, id: f.file };
    for (const t of (data.tables || [])) m[t.file] = { ...t, id: t.file };
    return m;
  }, [data]);

  const goToDeps = (id) => { setFocal(id); setTab("flow"); };

  const NAV = [
    { id: "heat", label: "Code heatmap", icon: Flame },
    { id: "db", label: "DB heatmap", icon: Database },
    { id: "flow", label: "Dependency flow", icon: Workflow },
    { id: "arch", label: "Architecture", icon: Boxes },
    { id: "reports", label: "Reports", icon: ClipboardList },
    { id: "chat", label: "Ask", icon: MessageCircle },
  ];

  return (
    <div style={{ fontFamily: "Inter, system-ui, sans-serif", background: "#F5F9FD", minHeight: "100vh", color: "#0F2540", display: "flex", flexDirection: "column" }}>
      {showAdmin && <AdminPanel onClose={() => setShowAdmin(false)} />}
      {jobRunning && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, padding: "8px 16px", background: "#E7F4FE", color: "#0369A1", fontSize: 12.5, fontWeight: 600 }}>
          <Loader2 size={13} className="spin-dashboard" /> Analyzing in the background ({STEP_LABELS[jobStep] || "working…"}) — the dashboard below stays interactive with the last completed results; it'll refresh automatically when this finishes.
        </div>
      )}
      {justCompleted && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "8px 16px", background: "#E7F9F1", color: "#0F7B4E", fontSize: 12.5, fontWeight: 600 }}>
          <Check size={13} /> Analysis complete — showing the latest results.
          <button onClick={onDismissComplete} style={{ background: "none", border: "none", cursor: "pointer", color: "#0F7B4E", padding: 0, textDecoration: "underline", fontSize: 12.5, fontWeight: 600 }}>Dismiss</button>
        </div>
      )}
      {jobError && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, padding: "8px 16px", background: "#FDECEC", color: "#9F1D1D", fontSize: 12.5, fontWeight: 600 }}>
          <AlertTriangle size={13} /> Background analysis failed: {jobError}
          <button onClick={onDismissError} style={{ background: "none", border: "none", cursor: "pointer", color: "#9F1D1D", padding: 0, textDecoration: "underline", fontSize: 12.5, fontWeight: 600 }}>Dismiss</button>
        </div>
      )}
      <style>{`.spin-dashboard { animation: spinDashboard 1s linear infinite; display: inline-block; } @keyframes spinDashboard { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 22px", borderBottom: "1px solid #E1EBF5", background: "#FFFFFF", flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: "#0EA5E9", display: "flex", alignItems: "center", justifyContent: "center" }}><Flame size={16} color="white" /></div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Tech Engineering Debt Radar</div>
            <div style={{ fontSize: 11.5, color: "#93A7BF", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span>repo: {data.repo}{hasDb ? " · db connected" : " · no database analyzed"}</span>
              {(data.repos?.length > 1
                ? data.repos.map((r) => <TechBadge key={r.slug} label={`${r.name}: ${codeLangsLabel(r.code_langs, r.frameworks)}`} />)
                : data.code_langs?.length > 0 && <TechBadge label={codeLangsLabel(data.code_langs, data.frameworks)} />)}
              {(data.databases?.length > 1
                ? data.databases.map((d) => <TechBadge key={d.slug} label={`${d.name}: ${DB_DIALECT_LABELS[d.dialect] || d.dialect}`} />)
                : data.db_dialect && <TechBadge label={DB_DIALECT_LABELS[data.db_dialect] || data.db_dialect} />)}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <Stat label="Files" value={data.summary.total_files} />
          {hasDb && <Stat label="Tables" value={data.summary.total_tables} />}
          <Stat label="Edges" value={data.summary.total_edges} />
          <Stat label="High-debt items" value={data.summary.high_debt_count} accent />
          <div style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11.5, color: "#5B7290", background: "#F3F8FD", padding: "5px 10px", borderRadius: 99 }}>
            <Clock size={11} /> updated {timeAgo(data.generated_at)}
          </div>
          <button onClick={() => setShowAdmin(true)} title="Admin — AI provider settings"
            style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600, color: "#5B7290", background: "#F3F8FD", border: "1px solid #E1EBF5", borderRadius: 8, padding: "7px 10px", cursor: "pointer" }}>
            <Settings size={13} />
          </button>
          <button onClick={onReanalyze} disabled={jobRunning} title={jobRunning ? "An analysis is already running in the background" : undefined}
            style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600, color: jobRunning ? "#93A7BF" : "#0369A1", background: jobRunning ? "#F3F8FD" : "#E7F4FE", border: "none", borderRadius: 8, padding: "7px 12px", cursor: jobRunning ? "default" : "pointer" }}>
            <RefreshCw size={12} /> New analysis
          </button>
        </div>
      </header>

      <div style={{ display: "flex", flex: 1, minHeight: 560 }}>
        <nav style={{ width: 180, flexShrink: 0, borderRight: "1px solid #E1EBF5", background: "#FFFFFF", padding: "16px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
          {NAV.map((n) => (
            <button key={n.id} onClick={() => setTab(n.id)}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 9, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, textAlign: "left", background: tab === n.id ? "#E7F4FE" : "transparent", color: tab === n.id ? "#0369A1" : "#5B7290" }}>
              <n.icon size={16} /> {n.label}
            </button>
          ))}
        </nav>
        <main style={{ flex: 1, padding: 22, minWidth: 0 }}>
          {tab === "heat" && (
            <HeatmapPane
              items={data.files.map((f) => ({ ...f, id: f.file }))} sizeKey="loc" groupByDir
              legendNote="Grouped by folder · tile size = lines of code · color = debt score. Click a tile for detail."
              selected={selectedFile} setSelected={setSelectedFile} goToDeps={goToDeps}
              detailFields={[
                ["Lines of code", "loc"], ["Avg. complexity", "avg_complexity"], ["Max. complexity", "max_complexity"],
                ["Maintainability index", "maintainability_index", "0–100, lower is worse"], ["Commits (2yr churn)", "churn"],
                ["Long functions (>50 lines)", "long_function_count"], ["Max nesting depth", "max_nesting_depth"],
                ["Many-parameter functions", "many_params_count"], ["Duplicate functions", "duplicate_function_count"],
                ["Public functions/methods", "public_function_count"], ["Long if/switch chains (>5 branches)", "long_conditional_chain_count"],
                ...(selectedFile && /\.[jt]sx?$/.test(selectedFile.id) ? [
                  ["'any' usages", "any_usage_count"], ["tsconfig strict mode off", "non_strict_typescript"],
                  ["All-static utility classes", "static_utility_class_count"], ["Props/inputs with >4 booleans", "many_boolean_props_count"],
                ] : []),
                ["Security findings", "security_issue_count"], ["Depends on", "fan_out"], ["Depended on by", "fan_in"],
              ]}
            />
          )}
          {tab === "db" && (
            hasDb ? (
              <HeatmapPane
                items={(data.tables || []).map((t) => ({ ...t, id: t.file }))} sizeKey="row_estimate"
                legendNote="Tile size = row count (or column count if unknown) · color = DB debt score. Click a tile for detail."
                selected={selectedTable} setSelected={setSelectedTable} goToDeps={goToDeps}
                detailFields={[["Row estimate", "row_estimate"], ["Columns", "column_count"], ["Foreign keys out", "fk_out"], ["Referenced by (fk_in)", "fk_in"], ["Missing indexed FKs", "missing_indexed_fks"], ["Missing primary key", "missing_primary_key"], ["Sensitive columns", "high_risk_columns"], ["PUBLIC write grants", "public_write_grants"]]}
              />
            ) : <NoDbNotice onReanalyze={onReanalyze} />
          )}
          {tab === "flow" && <FullGraphTab nodesById={nodesById} edges={data.edges} data={data} focal={focal} setFocal={setFocal} tiered emptyLabel="No dependency data yet." />}
          {tab === "arch" && <ArchitectureTab />}
          {tab === "reports" && <ReportsTab goToDeps={goToDeps} />}
          {tab === "chat" && <ChatTab data={data} />}
        </main>
      </div>
    </div>
  );
}

function NoDbNotice({ onReanalyze }) {
  return (
    <div style={{ background: "#FEF3E2", border: "1px solid #FBD9A5", borderRadius: 12, padding: 30, textAlign: "center" }}>
      <AlertTriangle size={22} color="#B45309" style={{ marginBottom: 10 }} />
      <div style={{ fontSize: 14, fontWeight: 700, color: "#0F2540", marginBottom: 6 }}>No database was analyzed in this run</div>
      <p style={{ fontSize: 13, color: "#5B7290", maxWidth: 420, margin: "0 auto 16px" }}>
        On the setup screen, the database step defaults to "Skip" unless you pick a connection string or SQL file — that's likely what happened here. Run a new analysis and choose one of those options to see DB debt, dependencies, and the combined graph.
      </p>
      <button onClick={onReanalyze} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "9px 16px", background: "#0EA5E9", color: "white", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
        <RefreshCw size={13} /> New analysis
      </button>
    </div>
  );
}

const DB_DIALECT_LABELS = { postgresql: "Postgres", postgres: "Postgres", mysql: "MySQL", mssql: "SQL Server" };

function oneCodeLangLabel(codeLang, framework) {
  if (codeLang === "dotnet") return ".NET";
  if (codeLang === "typescript") {
    if (framework === "react") return "TypeScript (React)";
    if (framework === "angular") return "TypeScript (Angular)";
    return "TypeScript";
  }
  return "Python";
}

function oneCodeLangDescription(codeLang, framework) {
  if (codeLang === "dotnet") return ".NET (C#, analyzed via Roslyn)";
  if (codeLang === "typescript") {
    const flavor = framework === "react" ? "React" : framework === "angular" ? "Angular" : "generic";
    return `TypeScript (${flavor}, analyzed via the TypeScript compiler)`;
  }
  return "Python";
}

// A single repo can itself be more than one language (e.g. a .NET backend
// alongside a separate JS/TS frontend folder) — codeLangs is a list, frameworks
// a {lang: framework} map; both join with " + " for display.
function codeLangsLabel(codeLangs, frameworks = {}) {
  return (codeLangs || []).map((lang) => oneCodeLangLabel(lang, frameworks[lang])).join(" + ") || "unknown";
}

function codeLangsDescription(codeLangs, frameworks = {}) {
  return (codeLangs || []).map((lang) => oneCodeLangDescription(lang, frameworks[lang])).join(" + ") || "unknown";
}

function TechBadge({ label }) {
  return (
    <span style={{ fontSize: 10.5, fontWeight: 600, color: "#0369A1", background: "#E7F4FE", border: "1px solid #CDE9FB", borderRadius: 99, padding: "1px 8px" }}>
      {label}
    </span>
  );
}

function Stat({ label, value, accent }) {
  return (
    <div style={{ textAlign: "right" }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: accent ? "#DC2626" : "#0F2540", fontFamily: "'IBM Plex Mono', monospace" }}>{value}</div>
      <div style={{ fontSize: 10.5, color: "#93A7BF" }}>{label}</div>
    </div>
  );
}
