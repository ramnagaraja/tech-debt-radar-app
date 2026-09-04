import React, { useState } from "react";
import {
  Folder, GitBranch, Database, FileText, Play, Loader2, Code2, Sparkles,
  Plus, X, BookOpen, ClipboardList,
} from "lucide-react";

const STEP_LABELS = {
  "resolving repositories": "Getting your code",
  "analyzing code (complexity, churn, imports, duplication)": "Analyzing code",
  "introspecting databases": "Reading your databases",
  "linking code to data": "Linking code to data",
  "fetching Jira/Confluence context": "Gathering project context",
  "writing results": "Saving results",
  "complete": "Done",
};

let nextEntryId = 1;
const newId = () => nextEntryId++;

function useEntryList(initial) {
  const [items, setItems] = useState(initial);
  const add = (item) => setItems((prev) => [...prev, { ...item, _id: newId() }]);
  const remove = (id) => setItems((prev) => prev.filter((i) => i._id !== id));
  const update = (id, patch) => setItems((prev) => prev.map((i) => (i._id === id ? { ...i, ...patch } : i)));
  return [items, { add, remove, update }];
}

const emptyRepo = () => ({ source: "local", value: "", name: "", code_lang: "auto" });
const emptyDb = () => ({ source: "connection_string", value: "", name: "", dialect: "auto" });
const emptyContext = () => ({ kind: "jira", url: "" });

export default function SetupScreen({ onReady }) {
  const [repos, repoOps] = useEntryList([{ ...emptyRepo(), _id: newId() }]);
  const [databases, dbOps] = useEntryList([]);
  const [contextSources, contextOps] = useEntryList([]);
  const [status, setStatus] = useState(null); // null | "running" | "error"
  const [step, setStep] = useState("");
  const [error, setError] = useState(null);

  const canSubmit = repos.length > 0 && repos.every((r) => r.value.trim().length > 0) && status !== "running";

  async function submit() {
    setStatus("running");
    setError(null);
    try {
      const resp = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repos: repos.map((r) => ({
            name: r.name.trim() || undefined, source: r.source, value: r.value.trim(), code_lang: r.code_lang,
          })),
          databases: databases.filter((d) => d.value.trim()).map((d) => ({
            name: d.name.trim() || undefined, source: d.source, value: d.value.trim(), dialect: d.dialect,
          })),
          external_context: contextSources.filter((c) => c.url.trim()).map((c) => ({ kind: c.kind, url: c.url.trim() })),
        }),
      });
      const json = await resp.json();
      if (!json.ok) throw new Error(json.message || "Could not start analysis.");
      poll();
    } catch (e) {
      setStatus("error");
      setError(e.message);
    }
  }

  function poll() {
    const interval = setInterval(async () => {
      const resp = await fetch("/api/status");
      const s = await resp.json();
      setStep(s.step);
      if (s.status === "done") {
        clearInterval(interval);
        const metricsResp = await fetch("/api/metrics");
        const data = await metricsResp.json();
        onReady(data);
      } else if (s.status === "error") {
        clearInterval(interval);
        setStatus("error");
        setError(s.error);
      }
    }, 1200);
  }

  return (
    <div style={{ minHeight: "100vh", background: "#F5F9FD", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Inter, system-ui, sans-serif", padding: 20 }}>
      <div style={{ width: 620, maxHeight: "92vh", overflowY: "auto", background: "#FFFFFF", border: "1px solid #E1EBF5", borderRadius: 16, padding: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: "#0EA5E9", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Database size={17} color="white" />
          </div>
          <div style={{ fontSize: 17, fontWeight: 700, color: "#0F2540" }}>Tech Engineering Debt Radar</div>
        </div>
        <p style={{ fontSize: 13, color: "#5B7290", marginTop: 6, marginBottom: 24 }}>
          Point this at one or more related codebases and databases — it analyzes all of them together and builds one combined heatmap, dependency map, and guidance chat.
        </p>

        <Field label="Repositories">
          {repos.map((repo, i) => (
            <EntryCard key={repo._id} onRemove={repos.length > 1 ? () => repoOps.remove(repo._id) : null}>
              <ToggleRow
                options={[{ id: "local", label: "Local / network path", icon: Folder }, { id: "git_url", label: "Git URL", icon: GitBranch }]}
                value={repo.source} onChange={(v) => repoOps.update(repo._id, { source: v })}
              />
              <input
                value={repo.value} onChange={(e) => repoOps.update(repo._id, { value: e.target.value })}
                placeholder={repo.source === "local" ? "/home/you/backend  ·  \\\\fileserver\\share\\backend" : "https://github.com/org/backend.git"}
                style={inputStyle}
              />
              <input
                value={repo.name} onChange={(e) => repoOps.update(repo._id, { name: e.target.value })}
                placeholder={`Display name (optional${repos.length > 1 ? " — also used to tell files apart in the combined view" : ""})`}
                style={{ ...inputStyle, marginTop: 8 }}
              />
              <div style={{ marginTop: 10 }}>
                <ToggleRow
                  options={[
                    { id: "auto", label: "Auto-detect", icon: Sparkles },
                    { id: "python", label: "Python", icon: Code2 },
                    { id: "dotnet", label: ".NET", icon: Code2 },
                  ]}
                  value={repo.code_lang} onChange={(v) => repoOps.update(repo._id, { code_lang: v })}
                />
              </div>
              {repo.code_lang === "dotnet" && (
                <p style={{ fontSize: 11.5, color: "#93A7BF", marginTop: 2, marginBottom: 0 }}>
                  Uses a Roslyn-based analyzer — requires the .NET SDK on this machine and this repo's packages already restored (<code>dotnet restore</code>).
                </p>
              )}
            </EntryCard>
          ))}
          <AddButton label="Add another repository" onClick={() => repoOps.add(emptyRepo())} />
        </Field>

        <Field label="Databases — include any for DB debt, DB dependencies, and the combined code+data view" optional>
          {databases.length === 0 && (
            <p style={{ fontSize: 11.5, color: "#B45309", background: "#FEF3E2", border: "1px solid #FBD9A5", borderRadius: 7, padding: "7px 10px", marginBottom: 8 }}>
              No database added — you'll get the code heatmap only, no DB heatmap, DB dependency graph, or code-to-table links.
            </p>
          )}
          {databases.map((db) => (
            <EntryCard key={db._id} onRemove={() => dbOps.remove(db._id)}>
              <ToggleRow
                options={[
                  { id: "connection_string", label: "Connection string", icon: Database },
                  { id: "sql_file", label: "SQL schema file", icon: FileText },
                ]}
                value={db.source} onChange={(v) => dbOps.update(db._id, { source: v })}
              />
              <input
                value={db.value} onChange={(e) => dbOps.update(db._id, { value: e.target.value })}
                placeholder={
                  db.source === "connection_string"
                    ? "postgresql://user:pass@host:5432/db  ·  mysql+pymysql://user:pass@host/db  ·  mssql+pyodbc://user:pass@host/db?driver=ODBC+Driver+18+for+SQL+Server"
                    : "/path/to/schema.sql  ·  \\\\fileserver\\share\\schema.sql"
                }
                style={inputStyle}
              />
              <input
                value={db.name} onChange={(e) => dbOps.update(db._id, { name: e.target.value })}
                placeholder={`Display name (optional${databases.length > 1 ? " — also used to tell tables apart in the combined view" : ""})`}
                style={{ ...inputStyle, marginTop: 8 }}
              />
              {db.source === "connection_string" && (
                <p style={{ fontSize: 11.5, color: "#93A7BF", marginTop: 6, marginBottom: 0 }}>
                  Read-only introspection — this never writes to your database. Postgres, MySQL/MariaDB, and SQL Server are supported (dialect is read from the connection string itself).
                </p>
              )}
              {db.source === "sql_file" && (
                <div style={{ marginTop: 8 }}>
                  <ToggleRow
                    options={[
                      { id: "auto", label: "Auto", icon: Sparkles },
                      { id: "postgres", label: "Postgres", icon: Database },
                      { id: "mysql", label: "MySQL", icon: Database },
                      { id: "mssql", label: "SQL Server", icon: Database },
                    ]}
                    value={db.dialect} onChange={(v) => dbOps.update(db._id, { dialect: v })}
                  />
                  <p style={{ fontSize: 11.5, color: "#93A7BF", marginTop: 2, marginBottom: 0 }}>
                    A .sql file doesn't self-identify its dialect — pick one if auto-detect guesses wrong.
                  </p>
                </div>
              )}
            </EntryCard>
          ))}
          <AddButton label="Add a database" onClick={() => dbOps.add(emptyDb())} />
        </Field>

        <Field label="Project context — Jira / Confluence" optional>
          <p style={{ fontSize: 11.5, color: "#93A7BF", marginTop: -4, marginBottom: 8 }}>
            Fed into the AI's context for the Ask tab and recommendations. Set the Atlassian email + API token once under Admin — the same pair works for both.
          </p>
          {contextSources.map((ctx) => (
            <EntryCard key={ctx._id} onRemove={() => contextOps.remove(ctx._id)}>
              <ToggleRow
                options={[
                  { id: "jira", label: "Jira", icon: ClipboardList },
                  { id: "confluence", label: "Confluence", icon: BookOpen },
                ]}
                value={ctx.kind} onChange={(v) => contextOps.update(ctx._id, { kind: v })}
              />
              <input
                value={ctx.url} onChange={(e) => contextOps.update(ctx._id, { url: e.target.value })}
                placeholder={
                  ctx.kind === "jira"
                    ? "https://yourorg.atlassian.net/browse/PROJ-123"
                    : "https://yourorg.atlassian.net/wiki/spaces/TEAM/pages/12345/Page+Title"
                }
                style={inputStyle}
              />
            </EntryCard>
          ))}
          <AddButton label="Add a Jira or Confluence link" onClick={() => contextOps.add(emptyContext())} />
        </Field>

        {status === "error" && (
          <div style={{ background: "#FDECEC", color: "#B91C1C", padding: "10px 12px", borderRadius: 8, fontSize: 12.5, marginBottom: 16 }}>
            {error || "Something went wrong."}
          </div>
        )}

        <button
          onClick={submit} disabled={!canSubmit}
          style={{
            width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            padding: "12px 0", borderRadius: 10, border: "none", fontSize: 14, fontWeight: 600, cursor: canSubmit ? "pointer" : "default",
            background: canSubmit ? "#0EA5E9" : "#CFE4F5", color: "white",
          }}
        >
          {status === "running" ? (
            <><Loader2 size={16} className="spin" /> {STEP_LABELS[step] || "Working…"}</>
          ) : (
            <><Play size={15} /> Run analysis</>
          )}
        </button>
      </div>
      <style>{`.spin { animation: spin 1s linear infinite; } @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function Field({ label, optional, children }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: "#0F2540", marginBottom: 8 }}>
        {label} {optional && <span style={{ fontWeight: 400, color: "#93A7BF" }}>(optional)</span>}
      </div>
      {children}
    </div>
  );
}

function EntryCard({ children, onRemove }) {
  return (
    <div style={{ position: "relative", border: "1px solid #E1EBF5", borderRadius: 10, padding: "12px 12px 10px", marginBottom: 10, background: "#FBFDFF" }}>
      {onRemove && (
        <button onClick={onRemove} title="Remove"
          style={{ position: "absolute", top: 8, right: 8, background: "none", border: "none", cursor: "pointer", color: "#93A7BF", padding: 2, lineHeight: 0 }}>
          <X size={14} />
        </button>
      )}
      {children}
    </div>
  );
}

function AddButton({ label, onClick }) {
  return (
    <button onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 6, background: "none", border: "1px dashed #C7DBEE",
        borderRadius: 8, padding: "7px 12px", fontSize: 12, fontWeight: 600, color: "#0369A1", cursor: "pointer", width: "100%", justifyContent: "center",
      }}>
      <Plus size={13} /> {label}
    </button>
  );
}

function ToggleRow({ options, value, onChange }) {
  return (
    <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
      {options.map((o) => (
        <button key={o.id} onClick={() => onChange(o.id)}
          style={{
            flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            padding: "8px 6px", borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: "pointer",
            border: value === o.id ? "1.5px solid #0EA5E9" : "1px solid #DCEAF6",
            background: value === o.id ? "#E7F4FE" : "#FFFFFF",
            color: value === o.id ? "#0369A1" : "#5B7290",
          }}>
          <o.icon size={13} /> {o.label}
        </button>
      ))}
    </div>
  );
}

const inputStyle = {
  width: "100%", boxSizing: "border-box", padding: "9px 12px", borderRadius: 8,
  border: "1px solid #C7DBEE", fontSize: 13, outline: "none", fontFamily: "'IBM Plex Mono', monospace",
};
