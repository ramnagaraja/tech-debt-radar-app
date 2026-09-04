import React, { useState } from "react";
import { Folder, GitBranch, Database, FileText, Play, Loader2, AlertCircle, Code2, Sparkles } from "lucide-react";

const STEP_LABELS = {
  "resolving repository": "Getting your code",
  "analyzing code (complexity, churn, imports)": "Analyzing code",
  "introspecting live database": "Reading your database",
  "parsing SQL schema file": "Reading your schema file",
  "linking code to data": "Linking code to data",
  "writing results": "Saving results",
  "complete": "Done",
};

export default function SetupScreen({ onReady }) {
  const [repoSource, setRepoSource] = useState("local");
  const [repoValue, setRepoValue] = useState("");
  const [repoName, setRepoName] = useState("");
  const [codeLang, setCodeLang] = useState("auto");
  const [dbSource, setDbSource] = useState("none");
  const [dbValue, setDbValue] = useState("");
  const [dbDialect, setDbDialect] = useState("auto");
  const [status, setStatus] = useState(null); // null | "running" | "error"
  const [step, setStep] = useState("");
  const [error, setError] = useState(null);

  const canSubmit = repoValue.trim().length > 0 && status !== "running";

  async function submit() {
    setStatus("running");
    setError(null);
    try {
      const resp = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repo_source: repoSource,
          repo_value: repoValue.trim(),
          repo_name: repoName.trim() || undefined,
          code_lang: codeLang,
          db_source: dbSource === "none" ? null : dbSource,
          db_value: dbSource === "none" ? null : dbValue.trim(),
          db_dialect: dbDialect,
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
      <div style={{ width: 520, background: "#FFFFFF", border: "1px solid #E1EBF5", borderRadius: 16, padding: 32 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: "#0EA5E9", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Database size={17} color="white" />
          </div>
          <div style={{ fontSize: 17, fontWeight: 700, color: "#0F2540" }}>Tech Engineering Debt Radar</div>
        </div>
        <p style={{ fontSize: 13, color: "#5B7290", marginTop: 6, marginBottom: 24 }}>
          Point this at a codebase and, optionally, a database — it analyzes both and builds the heatmap, dependency map, and guidance chat.
        </p>

        <Field label="Codebase">
          <ToggleRow
            options={[{ id: "local", label: "Local path", icon: Folder }, { id: "git_url", label: "Git URL", icon: GitBranch }]}
            value={repoSource} onChange={setRepoSource}
          />
          <input
            value={repoValue} onChange={(e) => setRepoValue(e.target.value)}
            placeholder={repoSource === "local" ? "/home/you/backend" : "https://github.com/org/backend.git"}
            style={inputStyle}
          />
          <input
            value={repoName} onChange={(e) => setRepoName(e.target.value)}
            placeholder="Display name (optional)"
            style={{ ...inputStyle, marginTop: 8 }}
          />
          <div style={{ marginTop: 10 }}>
            <ToggleRow
              options={[
                { id: "auto", label: "Auto-detect", icon: Sparkles },
                { id: "python", label: "Python", icon: Code2 },
                { id: "dotnet", label: ".NET", icon: Code2 },
              ]}
              value={codeLang} onChange={setCodeLang}
            />
          </div>
          {codeLang === "dotnet" && (
            <p style={{ fontSize: 11.5, color: "#93A7BF", marginTop: 2 }}>
              Uses a Roslyn-based analyzer — requires the .NET SDK on this machine and the repo's packages already restored (<code>dotnet restore</code>).
            </p>
          )}
        </Field>

        <Field label="Database — include it for DB debt, DB dependencies, and the combined code+data view">
          <ToggleRow
            options={[
              { id: "none", label: "Skip", icon: AlertCircle },
              { id: "connection_string", label: "Connection string", icon: Database },
              { id: "sql_file", label: "SQL schema file", icon: FileText },
            ]}
            value={dbSource} onChange={setDbSource}
          />
          {dbSource === "none" && (
            <p style={{ fontSize: 11.5, color: "#B45309", background: "#FEF3E2", border: "1px solid #FBD9A5", borderRadius: 7, padding: "7px 10px", marginTop: 6 }}>
              Skipping means no DB heatmap, no DB dependency graph, and no code-to-table links. Pick one of the other two options if you want those.
            </p>
          )}
          {dbSource !== "none" && (
            <input
              value={dbValue} onChange={(e) => setDbValue(e.target.value)}
              placeholder={
                dbSource === "connection_string"
                  ? "postgresql://user:pass@host:5432/db  ·  mysql+pymysql://user:pass@host/db  ·  mssql+pyodbc://user:pass@host/db?driver=ODBC+Driver+18+for+SQL+Server"
                  : "/path/to/schema.sql"
              }
              style={{ ...inputStyle, marginTop: 8 }}
            />
          )}
          {dbSource === "connection_string" && (
            <p style={{ fontSize: 11.5, color: "#93A7BF", marginTop: 6 }}>
              Read-only introspection — this never writes to your database. Postgres, MySQL/MariaDB, and SQL Server are supported (dialect is read from the connection string itself).
            </p>
          )}
          {dbSource === "sql_file" && (
            <div style={{ marginTop: 8 }}>
              <ToggleRow
                options={[
                  { id: "auto", label: "Auto", icon: Sparkles },
                  { id: "postgres", label: "Postgres", icon: Database },
                  { id: "mysql", label: "MySQL", icon: Database },
                  { id: "mssql", label: "SQL Server", icon: Database },
                ]}
                value={dbDialect} onChange={setDbDialect}
              />
              <p style={{ fontSize: 11.5, color: "#93A7BF", marginTop: 2 }}>
                A .sql file doesn't self-identify its dialect — pick one if auto-detect guesses wrong.
              </p>
            </div>
          )}
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

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{ fontSize: 12.5, fontWeight: 600, color: "#0F2540", marginBottom: 8 }}>{label}</div>
      {children}
    </div>
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
