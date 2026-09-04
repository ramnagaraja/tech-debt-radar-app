import React, { useState, useMemo, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ResponsiveContainer, Treemap, Tooltip as RTooltip } from "recharts";
import * as d3 from "d3";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Flame, GitBranch, MessageCircle, Database, ThumbsUp, ThumbsDown, Search, ArrowRight,
  Clock, Send, RefreshCw, Info, Sparkles, ShieldAlert, X, Settings, AlertTriangle, Palette,
} from "lucide-react";
import AdminPanel from "./AdminPanel.jsx";

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
  loc: "Total lines of code in the file, including blank lines and comments (radon for Python, Roslyn for .NET). Used as the treemap tile size — bigger files are easier to spot at a glance.",
  avg_complexity: "Average cyclomatic complexity across all functions in this file (radon for Python, Roslyn for .NET). Cyclomatic complexity counts independent decision paths (if/for/while/catch branches) — more branching means a higher number. Above ~10 per function is generally considered hard to test and maintain.",
  max_complexity: "The single most complex function in this file — its highest cyclomatic complexity score. A high max with a low average usually means one function needs breaking up, even if the rest of the file looks fine.",
  maintainability_index: "A 0–100 composite score computed from Halstead volume, cyclomatic complexity, and lines of code together. Below 65 is generally considered hard to maintain; below 20 is very difficult. This is the single biggest input to the 'design' slice of the debt score.",
  churn: "Number of commits touching this file in the last 2 years, from git log. Frequently-changed files carry more risk per edit and are weighted into the debt score — a file that's both complex AND frequently touched is the classic hotspot.",
  long_function_count: "Functions longer than 50 lines in this file, detected by walking the file's syntax tree. A classic 'this function does too much' smell — one of several signals feeding the design score.",
  max_nesting_depth: "The deepest level of nested if/for/while/try blocks found in any function in this file. Deep nesting (past ~4 levels) makes code hard to follow and easy to break; also feeds the design score.",
  many_params_count: "Functions with more than 5 parameters in this file — often a sign a function is doing too much and would benefit from being split or taking a parameter object instead.",
  fan_out: "Number of other files this file imports from (or references, for .NET). High fan-out means this file depends on a lot of moving parts — changes elsewhere in the codebase are more likely to affect it.",
  fan_in: "Number of other files that import/reference this one — its 'blast radius'. High fan-in means changes to this file are more likely to ripple outward and break something else; a good signal for prioritizing what to make safe to change first.",
  security_issue_count: "Total findings from real static analysis run against this file (bandit for Python; a Roslyn semantic-analysis pass for .NET — SQL injection patterns, weak crypto, hardcoded secrets, insecure deserialization, command injection). Each finding has a severity (LOW/MEDIUM/HIGH) and a confidence level, both of which weight how much they move the debt score.",
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
  design: "A blend of maintainability index, long functions, deep nesting, too many parameters, and oversized files (code) — or missing primary key, unenforced relationships, and table width (data).",
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
function edgeColor(edgeType) {
  if (edgeType === "code_to_table") return "#F59E0B"; // amber, dashed
  if (edgeType === "db_fk") return "#6366F1"; // indigo
  return "#94A3B8"; // slate — code_import
}

function nodeRadius(d) {
  const degree = (d.fan_in ?? d.fk_in ?? 0) + (d.fan_out ?? d.fk_out ?? 0);
  return Math.max(7, Math.min(22, 7 + Math.sqrt(degree) * 3.2));
}

function buildNodeRecommendationPrompt(data, node, outs, ins) {
  const isTable = node.kind === "table";
  const lines = [`Item: ${node.id} (${isTable ? "database table" : "code file"})`, `Debt score: ${node.debt_score}`];
  if (!isTable) {
    lines.push(`Avg complexity: ${node.avg_complexity} | Max complexity: ${node.max_complexity} | Maintainability index: ${node.maintainability_index}`);
    lines.push(`Churn (2yr commits): ${node.churn} | Long functions: ${node.long_function_count} | Max nesting depth: ${node.max_nesting_depth} | God file: ${node.god_file}`);
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

function FullGraphTab({ nodesById, edges, data, focal, setFocal, filterKind, emptyLabel }) {
  const svgRef = useRef(null);
  const nodeSelRef = useRef(null);
  const linkSelRef = useRef(null);
  const simNodesRef = useRef([]);
  const zoomRef = useRef(null);
  const [query, setQuery] = useState("");
  const [colorBy, setColorBy] = useState("debt");
  const [recommendation, setRecommendation] = useState({ forId: null, loading: false, text: "", error: false });

  const nodes = useMemo(() => {
    const all = Object.values(nodesById);
    return filterKind ? all.filter((n) => n.kind === filterKind) : all;
  }, [nodesById, filterKind]);
  const nodeIdSet = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);
  const scopedEdges = useMemo(() => {
    const base = filterKind ? edges.filter((e) => e.edge_type !== "code_to_table") : edges;
    return base.filter((e) => nodeIdSet.has(e.source) && nodeIdSet.has(e.target));
  }, [edges, filterKind, nodeIdSet]);
  const scopedNodesById = useMemo(() => {
    const m = {};
    for (const n of nodes) m[n.id] = n;
    return m;
  }, [nodes]);

  async function getRecommendations(node, outs, ins) {
    setRecommendation({ forId: node.id, loading: true, text: "", error: false });
    try {
      const prompt = buildNodeRecommendationPrompt(data, node, outs, ins);
      const res = await fetch(CHAT_API_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          max_tokens: 900,
          system: "You are a staff engineer giving remediation guidance for one specific file or database table in an engineering-debt dashboard. Use ONLY the data given — never invent metrics. Structure your answer in markdown with these sections: '## What's driving the debt score' (2-3 sentences tying the score components to what you see), '## Recommended fixes' (a prioritized numbered list, most impactful first, each with a one-line why), and '## Quick win' (the single smallest change that would help soonest). End with a line of the exact form '**Confidence: High|Medium|Low** — <one short reason>' reflecting how directly the data supports these recommendations. Be concrete and specific to the actual metrics/issues listed, not generic advice.",
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const json = await res.json();
      const text = (json.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n") || "No response.";
      setRecommendation({ forId: node.id, loading: false, text, error: false });
    } catch (e) {
      setRecommendation({ forId: node.id, loading: false, text: "Couldn't reach the guidance model.", error: true });
    }
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

    const sim = d3.forceSimulation(simNodes)
      .force("link", d3.forceLink(simLinks).id((d) => d.id).distance(65).strength(0.22))
      .force("charge", d3.forceManyBody().strength(-130))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collide", d3.forceCollide((d) => nodeRadius(d) + 8));

    const linkSel = zoomLayer.append("g").selectAll("line").data(simLinks).join("line")
      .attr("stroke", (d) => edgeColor(d.edge_type))
      .attr("stroke-width", 1.2)
      .attr("stroke-dasharray", (d) => (d.edge_type === "code_to_table" ? "3,3" : null))
      .attr("opacity", 0.45)
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

    nodeSel.on("click", (event, d) => { event.stopPropagation(); setFocal(d.id); });
    svg.on("click", () => setFocal(null));

    nodeSel.call(
      d3.drag()
        .on("start", (event, d) => { if (!event.active) sim.alphaTarget(0.25).restart(); d.fx = d.x; d.fy = d.y; })
        .on("drag", (event, d) => { d.fx = event.x; d.fy = event.y; })
        .on("end", (event, d) => { if (!event.active) sim.alphaTarget(0); d.fx = null; d.fy = null; })
    );

    const zoom = d3.zoom().scaleExtent([0.35, 4]).on("zoom", (event) => zoomLayer.attr("transform", event.transform));
    svg.call(zoom);
    zoomRef.current = { zoom, svg, width, height };

    sim.on("tick", () => {
      linkSel.attr("x1", (d) => d.source.x).attr("y1", (d) => d.source.y).attr("x2", (d) => d.target.x).attr("y2", (d) => d.target.y);
      nodeSel.attr("transform", (d) => `translate(${d.x},${d.y})`);
    });

    nodeSelRef.current = nodeSel;
    return () => sim.stop();
  }, [nodes, scopedEdges, setFocal]);

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
      linkSel.attr("opacity", 0.45).attr("stroke-width", 1.2);
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
  }, [focal, scopedEdges]);

  useEffect(() => { setRecommendation({ forId: null, loading: false, text: "", error: false }); }, [focal]);

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

      <div style={{ position: "relative", flex: 1, background: "#FFFFFF", border: "1px solid #E1EBF5", borderRadius: 12, minHeight: 420, overflow: "hidden" }}>
        <svg ref={svgRef} width="100%" height="100%" style={{ display: "block" }} />

        {focalNode && (
          <div style={{ position: "absolute", top: 14, right: 14, width: 240, background: "rgba(255,255,255,0.97)", border: "1px solid #E1EBF5", borderRadius: 10, padding: 14, boxShadow: "0 8px 24px rgba(15,37,64,0.10)" }}>
            <div style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 12, color: "#0F2540", fontWeight: 700, wordBreak: "break-all", marginBottom: 6 }}>{focal}</div>
            <div style={{ display: "inline-block", fontSize: 11, padding: "2px 7px", borderRadius: 99, background: debtColor(focalNode.debt_score ?? 0), color: textOnColor(debtColor(focalNode.debt_score ?? 0)), marginBottom: 10, fontWeight: 700 }}>
              debt {(focalNode.debt_score ?? 0).toFixed(2)}
            </div>
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
              style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "8px 0", background: "#0EA5E9", color: "white", border: "none", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer", opacity: recommendation.loading ? 0.6 : 1 }}>
              <Sparkles size={13} /> {recommendation.loading ? "Generating…" : "Get recommendations"}
            </button>
          </div>
        )}

        {recommendation.forId === focal && (recommendation.text || recommendation.loading) && (
          <div style={{ position: "absolute", top: 14, left: 14, width: 340, maxHeight: "calc(100% - 60px)", overflowY: "auto", background: "#FFFFFF", border: "1px solid #E1EBF5", borderRadius: 10, padding: 16, boxShadow: "0 12px 32px rgba(15,37,64,0.16)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 700, color: "#0369A1" }}><Sparkles size={13} /> Recommendations for {shortName(focal)}</div>
              <button onClick={() => setRecommendation({ forId: null, loading: false, text: "", error: false })} style={{ background: "none", border: "none", cursor: "pointer", color: "#93A7BF" }}><X size={14} /></button>
            </div>
            {recommendation.loading ? (
              <div style={{ fontSize: 12.5, color: "#93A7BF" }}>Thinking through the metrics…</div>
            ) : (
              <AnswerBlock text={recommendation.text} error={recommendation.error} />
            )}
          </div>
        )}

        <div style={{ position: "absolute", bottom: 10, left: 12, display: "flex", gap: 14, fontSize: 10.5, color: "#7B8FA8", background: "rgba(255,255,255,0.9)", padding: "5px 10px", borderRadius: 8 }}>
          <span>● circle = file</span>
          <span>▪ square = table</span>
          <span style={{ color: "#6366F1" }}>— foreign key</span>
          <span style={{ color: "#F59E0B" }}>┄ code → table</span>
        </div>
      </div>
      <p style={{ fontSize: 12, color: "#93A7BF", marginTop: 8 }}>Drag nodes to rearrange, scroll to zoom, click a node to focus it — click empty space to clear.</p>
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

function buildContext(data) {
  const topFiles = [...data.files].sort((a, b) => b.debt_score - a.debt_score).slice(0, 12);
  const topTables = [...(data.tables || [])].sort((a, b) => b.debt_score - a.debt_score).slice(0, 8);
  return `Repository: ${data.repo}
Codebase tech: ${data.code_lang === "dotnet" ? ".NET (C#, analyzed via Roslyn)" : "Python"}${data.db_dialect ? ` | Database: ${DB_DIALECT_LABELS[data.db_dialect] || data.db_dialect}` : ""}
Metrics last computed: ${data.generated_at}
Files: ${data.summary.total_files} | Tables: ${data.summary.total_tables} | Edges: ${data.summary.total_edges} | Avg code debt: ${data.summary.avg_code_debt} | Avg DB debt: ${data.summary.avg_db_debt}

Code debt_score = 35% complexity + 20% churn + 25% security (static analysis findings) + 20% design (maintainability index, long functions, deep nesting, too many params, oversized files).
DB debt_score = 30% performance (unindexed FKs) + 15% size + 30% security (sensitive columns, broad write grants) + 25% design (missing PK, unenforced *_id relationships, table width).

Top files by debt score:
${topFiles.map((f) => `- ${f.file} | debt=${f.debt_score} (complexity=${f.score_breakdown?.complexity}, churn=${f.score_breakdown?.churn}, security=${f.score_breakdown?.security}, design=${f.score_breakdown?.design}) | avg_complexity=${f.avg_complexity} | churn=${f.churn} | security_issues=${f.security_issue_count}(${f.security_high_count} high) | fan_in=${f.fan_in}`).join("\n")}
${topTables.length ? `\nTop DB tables by debt score:\n${topTables.map((t) => `- ${t.file} | debt=${t.debt_score} (performance=${t.score_breakdown?.performance}, security=${t.score_breakdown?.security}, design=${t.score_breakdown?.design}) | rows=${t.row_estimate ?? "unknown"} | missing_indexed_fks=${t.missing_indexed_fks ?? "unknown"} | high_risk_columns=${(t.high_risk_columns||[]).join(",") || "none"} | missing_pk=${t.missing_primary_key} | fk_in=${t.fk_in}`).join("\n")}` : ""}
`;
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

// The model self-reports a High/Medium/Low confidence line at the end of
// each answer (requested in the system prompt) — we parse it out and show
// it as a badge rather than leaving it buried in the prose. This is a
// verbalized, model-reported signal, not a computed statistical probability.
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
      const res = await fetch(CHAT_API_URL, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          max_tokens: 1400,
          system: `You are the guidance layer of an engineering-debt dashboard for an engineering team. Answer ONLY using the metrics data below — never invent numbers, files, or tables that aren't listed, and never fabricate a business-impact estimate (dollars, hours saved, risk %) that isn't derivable from the data. Reference specific paths/tables and their actual values, including which score component (complexity/churn/security/design, or performance/security/design for tables) is driving the concern.

Format every answer in markdown with clear sections appropriate to the question — typically a short summary line, then '## '-headed sections such as findings, root causes, and recommendations, using bullet or numbered lists for anything enumerable and a table when comparing several files/tables side by side. Be thorough and specific rather than terse: this is a working reference the team will read carefully, not a one-line reply. Still avoid padding — every sentence should carry real information from the data.

End every answer with a line of the exact form '**Confidence: High|Medium|Low** — <one short reason>', reflecting how directly the specific data you were given supports the claims you made (High = every claim traces to a specific number in the data; Low = you had to infer or generalize beyond what's listed).${feedbackNote}\n\n${context}`,
          messages: [...messages, userMsg].map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      const json = await res.json();
      const textOut = (json.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n") || "No response.";
      const mentioned = [...data.files, ...(data.tables || [])].filter((f) => textOut.includes(shortName(f.file))).length;
      setMessages((m) => [...m, { role: "assistant", content: textOut, question: text, matched: mentioned, id: Date.now() }]);
    } catch (e) {
      setMessages((m) => [...m, { role: "assistant", content: "Couldn't reach the guidance model — check Admin settings for a valid API key.", error: true, id: Date.now() }]);
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
export default function Dashboard({ data, onReanalyze }) {
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

  const goToDeps = (id) => { setFocal(id); setTab("deps"); };

  const NAV = [
    { id: "heat", label: "Code heatmap", icon: Flame },
    { id: "db", label: "DB heatmap", icon: Database },
    { id: "deps", label: "Combined dependencies", icon: GitBranch },
    ...(hasDb ? [{ id: "dbdeps", label: "DB dependencies", icon: Database }] : []),
    { id: "chat", label: "Ask", icon: MessageCircle },
  ];

  return (
    <div style={{ fontFamily: "Inter, system-ui, sans-serif", background: "#F5F9FD", minHeight: "100vh", color: "#0F2540", display: "flex", flexDirection: "column" }}>
      {showAdmin && <AdminPanel onClose={() => setShowAdmin(false)} />}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 22px", borderBottom: "1px solid #E1EBF5", background: "#FFFFFF", flexWrap: "wrap", gap: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: "#0EA5E9", display: "flex", alignItems: "center", justifyContent: "center" }}><Flame size={16} color="white" /></div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Tech Engineering Debt Radar</div>
            <div style={{ fontSize: 11.5, color: "#93A7BF", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <span>repo: {data.repo}{hasDb ? " · db connected" : " · no database analyzed"}</span>
              {data.code_lang && <TechBadge label={data.code_lang === "dotnet" ? ".NET" : "Python"} />}
              {data.db_dialect && <TechBadge label={DB_DIALECT_LABELS[data.db_dialect] || data.db_dialect} />}
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
          <button onClick={onReanalyze} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600, color: "#0369A1", background: "#E7F4FE", border: "none", borderRadius: 8, padding: "7px 12px", cursor: "pointer" }}>
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
              detailFields={[["Lines of code", "loc"], ["Avg. complexity", "avg_complexity"], ["Max. complexity", "max_complexity"], ["Maintainability index", "maintainability_index", "0–100, lower is worse"], ["Commits (2yr churn)", "churn"], ["Long functions (>50 lines)", "long_function_count"], ["Max nesting depth", "max_nesting_depth"], ["Many-parameter functions", "many_params_count"], ["Security findings", "security_issue_count"], ["Depends on", "fan_out"], ["Depended on by", "fan_in"]]}
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
          {tab === "deps" && <FullGraphTab nodesById={nodesById} edges={data.edges} data={data} focal={focal} setFocal={setFocal} emptyLabel="No dependency data yet." />}
          {tab === "dbdeps" && (
            hasDb ? (
              <FullGraphTab nodesById={nodesById} edges={data.edges} data={data} focal={focal} setFocal={setFocal} filterKind="table" emptyLabel="No database tables to show." />
            ) : <NoDbNotice onReanalyze={onReanalyze} />
          )}
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
