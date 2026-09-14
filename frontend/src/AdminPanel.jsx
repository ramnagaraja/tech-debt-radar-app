import React, { useState, useEffect, useRef } from "react";
import { Settings, Key, Check, X, Loader2, ThumbsUp, ThumbsDown, Upload, FileText, Trash2, AlertCircle, GitPullRequestArrow, ShieldCheck, Terminal } from "lucide-react";

const PROVIDER_ORDER = ["anthropic", "gemini", "ollama"];
const PROVIDER_NOTES = {
  anthropic: "Native Anthropic API.",
  gemini: "Via Gemini's OpenAI-compatible endpoint.",
  ollama: "Runs fully on this machine via Ollama — zero per-call token cost, no data leaves this host. Needs `ollama serve` running and the model already pulled (e.g. `ollama pull qwen2.5`).",
};

export default function AdminPanel({ onClose }) {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({}); // { [provider]: { model, api_key } }
  const [atlassianForm, setAtlassianForm] = useState({ email: "", api_token: "" });
  const [gitTokenForm, setGitTokenForm] = useState({ github_token: "", gitlab_token: "" });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [stats, setStats] = useState(null);
  const [kbDocs, setKbDocs] = useState([]);
  const [kbUploading, setKbUploading] = useState(false);
  const [repos, setRepos] = useState([]); // from the last analysis run — [{slug, name}]
  const [miningStatus, setMiningStatus] = useState({}); // { [slug]: {status, error} }
  const [annotations, setAnnotations] = useState([]);
  const fileInputRef = useRef(null);

  useEffect(() => {
    fetch("/api/settings").then((r) => r.json()).then((s) => {
      setSettings(s);
      const f = {};
      for (const p of PROVIDER_ORDER) f[p] = { model: s.providers[p]?.model || "", api_key: "", base_url: s.providers[p]?.base_url || "" };
      setForm(f);
      setAtlassianForm({ email: s.atlassian?.email || "", api_token: "" });
      setGitTokenForm({ github_token: "", gitlab_token: "" });
    });
    fetch("/api/feedback/stats").then((r) => r.json()).then(setStats).catch(() => {});
    refreshKbDocs();
    fetch("/api/metrics").then((r) => r.json()).then((d) => { if (d.ready) setRepos(d.repos || []); }).catch(() => {});
    refreshAnnotations();
  }, []);

  function refreshAnnotations() {
    fetch("/api/annotations?status=pending").then((r) => r.json()).then((d) => setAnnotations(d.items || [])).catch(() => {});
  }

  async function decideAnnotation(id, decision) {
    await fetch(`/api/annotations/${id}/${decision}`, { method: "POST" });
    refreshAnnotations();
  }

  async function minePrHistory(slug) {
    setMiningStatus((m) => ({ ...m, [slug]: { status: "running", error: null } }));
    await fetch("/api/pr-insights/mine", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo_slug: slug }) });
    const poll = setInterval(async () => {
      const s = await fetch(`/api/pr-insights/status?repo_slug=${encodeURIComponent(slug)}`).then((r) => r.json());
      setMiningStatus((m) => ({ ...m, [slug]: s }));
      if (s.status === "done" || s.status === "error") clearInterval(poll);
    }, 2000);
  }

  function refreshKbDocs() {
    fetch("/api/knowledge/documents").then((r) => r.json()).then((d) => setKbDocs(d.documents || [])).catch(() => {});
  }

  // Poll while anything is still processing, so status/chunk-count update without a manual refresh.
  useEffect(() => {
    if (!kbDocs.some((d) => d.status === "processing")) return;
    const t = setInterval(refreshKbDocs, 2000);
    return () => clearInterval(t);
  }, [kbDocs]);

  async function uploadKbFile(file) {
    if (!file) return;
    setKbUploading(true);
    try {
      const body = new FormData();
      body.append("file", file);
      await fetch("/api/knowledge/upload", { method: "POST", body });
      refreshKbDocs();
    } catch {
      // surfaced via the document list itself once processing finishes (status: "error")
    }
    setKbUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function deleteKbDoc(id) {
    await fetch(`/api/knowledge/documents/${id}`, { method: "DELETE" });
    refreshKbDocs();
  }

  async function save() {
    setSaving(true);
    setSaved(false);
    const body = {
      active_provider: settings.active_provider,
      atlassian_email: atlassianForm.email,
      atlassian_api_token: atlassianForm.api_token || undefined,
      github_token: gitTokenForm.github_token || undefined,
      gitlab_token: gitTokenForm.gitlab_token || undefined,
    };
    for (const p of PROVIDER_ORDER) {
      body[`${p}_model`] = form[p]?.model || undefined;
      body[`${p}_api_key`] = form[p]?.api_key || undefined;
    }
    body.ollama_base_url = form.ollama?.base_url || undefined;
    const res = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) {
      const fresh = await fetch("/api/settings").then((r) => r.json());
      setSettings(fresh);
      const f = {};
      for (const p of PROVIDER_ORDER) f[p] = { model: fresh.providers[p]?.model || "", api_key: "", base_url: fresh.providers[p]?.base_url || "" };
      setForm(f);
      setAtlassianForm({ email: fresh.atlassian?.email || "", api_token: "" });
      setGitTokenForm({ github_token: "", gitlab_token: "" });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    }
    setSaving(false);
  }

  if (!settings) return null;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,37,64,0.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 }}>
      <div style={{ width: 560, maxHeight: "88vh", overflowY: "auto", background: "#FFFFFF", borderRadius: 14, padding: 26, boxShadow: "0 24px 60px rgba(15,37,64,0.3)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 16, fontWeight: 700, color: "#0F2540" }}>
            <Settings size={17} /> Admin settings
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#93A7BF" }}><X size={18} /></button>
        </div>
        <p style={{ fontSize: 12.5, color: "#5B7290", marginTop: 0, marginBottom: 20 }}>
          Choose which model powers the Ask tab and dependency recommendations, and the Atlassian credentials used to pull Jira/Confluence context into that guidance. Keys are stored locally in this app's own database, never sent anywhere except the provider (or Atlassian) they're for.
        </p>

        <div style={{ border: "1px solid #E1EBF5", borderRadius: 10, padding: 14, marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: "#0F2540" }}>External context — Jira &amp; Confluence</div>
            {settings.atlassian?.has_token ? (
              <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#0F7B4E", background: "#E7F9F1", padding: "2px 8px", borderRadius: 99 }}>
                <Check size={11} /> token set{settings.atlassian.token_preview ? ` (${settings.atlassian.token_preview})` : ""}
              </span>
            ) : (
              <span style={{ fontSize: 11, color: "#B45309", background: "#FEF3E2", padding: "2px 8px", borderRadius: 99 }}>no token yet</span>
            )}
          </div>
          <p style={{ fontSize: 11, color: "#7B8FA8", margin: "0 0 8px" }}>
            One Atlassian Cloud API token (from id.atlassian.com) authenticates both Jira and Confluence — used when you add Jira/Confluence links in Setup.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={atlassianForm.email} onChange={(e) => setAtlassianForm((f) => ({ ...f, email: e.target.value }))}
              placeholder="you@yourcompany.com" style={{ flex: 1, padding: "7px 10px", borderRadius: 7, border: "1px solid #DCEAF6", fontSize: 12 }}
            />
            <div style={{ flex: 1.4, position: "relative" }}>
              <Key size={12} style={{ position: "absolute", left: 9, top: 9, color: "#B7CDE3" }} />
              <input
                type="password" value={atlassianForm.api_token} onChange={(e) => setAtlassianForm((f) => ({ ...f, api_token: e.target.value }))}
                placeholder={settings.atlassian?.has_token ? "leave blank to keep existing token" : "paste API token"}
                style={{ width: "100%", boxSizing: "border-box", padding: "7px 10px 7px 26px", borderRadius: 7, border: "1px solid #DCEAF6", fontSize: 12 }}
              />
            </div>
          </div>
        </div>

        <div style={{ border: "1px solid #E1EBF5", borderRadius: 10, padding: 14, marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, color: "#0F2540" }}>Knowledge base — technical documents</div>
            <span style={{ fontSize: 11, color: "#5B7290", background: "#F3F8FD", padding: "2px 8px", borderRadius: 99 }}>{kbDocs.length} doc{kbDocs.length === 1 ? "" : "s"}</span>
          </div>
          <p style={{ fontSize: 11, color: "#7B8FA8", margin: "0 0 8px" }}>
            Upload PDF/DOCX/Markdown/text standards, runbooks, or architecture docs. The Ask tab and recommendations retrieve and cite relevant passages, with a real (embedding-similarity) confidence score — not just the model's own self-assessment. Embeddings run locally (fastembed) — no API key, nothing leaves this machine. Three built-in references (SOLID principles, design patterns, microservices architecture) are bundled by default, marked "Built-in" below.
          </p>
          <input ref={fileInputRef} type="file" accept=".pdf,.docx,.md,.txt" style={{ display: "none" }}
            onChange={(e) => uploadKbFile(e.target.files[0])} />
          <button onClick={() => fileInputRef.current?.click()} disabled={kbUploading}
            style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, width: "100%", padding: "8px 0", background: "none", border: "1px dashed #C7DBEE", borderRadius: 8, fontSize: 12, fontWeight: 600, color: "#0369A1", cursor: kbUploading ? "default" : "pointer", marginBottom: kbDocs.length ? 10 : 0 }}>
            {kbUploading ? <><Loader2 size={13} className="spin" /> Uploading…</> : <><Upload size={13} /> Upload a document (PDF, DOCX, MD, TXT)</>}
          </button>
          {kbDocs.map((doc) => (
            <div key={doc.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 2px", borderTop: "1px solid #F0F4F9", fontSize: 12 }}>
              <FileText size={13} color="#7B8FA8" style={{ flexShrink: 0 }} />
              <span style={{ flex: 1, color: "#0F2540", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{doc.filename}</span>
              {doc.status === "processing" && <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10.5, color: "#B45309" }}><Loader2 size={11} className="spin" /> indexing…</span>}
              {doc.status === "ready" && <span style={{ fontSize: 10.5, color: "#0F7B4E" }}>{doc.chunk_count} chunk{doc.chunk_count === 1 ? "" : "s"}</span>}
              {doc.status === "error" && (
                <span title={doc.error || "failed"} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10.5, color: "#B91C1C" }}>
                  <AlertCircle size={11} /> failed
                </span>
              )}
              {doc.is_builtin ? (
                <span title="Bundled with the app — SOLID / design patterns / microservices reference library" style={{ fontSize: 9.5, fontWeight: 700, color: "#5B3FA8", background: "#F1ECFB", padding: "1px 6px", borderRadius: 99, flexShrink: 0 }}>
                  Built-in
                </span>
              ) : (
                <button onClick={() => deleteKbDoc(doc.id)} title="Delete" style={{ background: "none", border: "none", cursor: "pointer", color: "#B7C4D6", padding: 2, lineHeight: 0, flexShrink: 0 }}>
                  <Trash2 size={13} />
                </button>
              )}
            </div>
          ))}
        </div>

        <div style={{ border: "1px solid #E1EBF5", borderRadius: 10, padding: 14, marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13.5, fontWeight: 700, color: "#0F2540" }}>
              <GitPullRequestArrow size={14} /> PR-history mining
            </div>
          </div>
          <p style={{ fontSize: 11, color: "#7B8FA8", margin: "0 0 8px" }}>
            Optional tokens for GitHub/GitLab.com — raises the API rate limit and unlocks private repos. Leave blank to mine public repos at the unauthenticated rate limit (usually enough for a single repo's recent history).
          </p>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <div style={{ flex: 1, position: "relative" }}>
              <Key size={12} style={{ position: "absolute", left: 9, top: 9, color: "#B7CDE3" }} />
              <input type="password" value={gitTokenForm.github_token} onChange={(e) => setGitTokenForm((f) => ({ ...f, github_token: e.target.value }))}
                placeholder={settings.pr_mining?.github_has_token ? `leave blank to keep existing (${settings.pr_mining.github_token_preview})` : "GitHub token (optional)"}
                style={{ width: "100%", boxSizing: "border-box", padding: "7px 10px 7px 26px", borderRadius: 7, border: "1px solid #DCEAF6", fontSize: 12 }} />
            </div>
            <div style={{ flex: 1, position: "relative" }}>
              <Key size={12} style={{ position: "absolute", left: 9, top: 9, color: "#B7CDE3" }} />
              <input type="password" value={gitTokenForm.gitlab_token} onChange={(e) => setGitTokenForm((f) => ({ ...f, gitlab_token: e.target.value }))}
                placeholder={settings.pr_mining?.gitlab_has_token ? `leave blank to keep existing (${settings.pr_mining.gitlab_token_preview})` : "GitLab token (optional)"}
                style={{ width: "100%", boxSizing: "border-box", padding: "7px 10px 7px 26px", borderRadius: 7, border: "1px solid #DCEAF6", fontSize: 12 }} />
            </div>
          </div>
          {repos.length === 0 ? (
            <p style={{ fontSize: 11, color: "#93A7BF", margin: 0 }}>Run an analysis first — mining works against the repo(s) from your last run.</p>
          ) : (
            repos.map((r) => {
              const st = miningStatus[r.slug];
              return (
                <div key={r.slug} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderTop: "1px solid #F0F4F9" }}>
                  <span style={{ flex: 1, fontSize: 12, color: "#0F2540", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</span>
                  {st?.status === "running" && <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10.5, color: "#B45309" }}><Loader2 size={11} className="spin" /> mining…</span>}
                  {st?.status === "done" && <span style={{ fontSize: 10.5, color: "#0F7B4E" }}>done</span>}
                  {st?.status === "error" && <span title={st.error} style={{ fontSize: 10.5, color: "#B91C1C" }}>failed — {st.error}</span>}
                  <button onClick={() => minePrHistory(r.slug)} disabled={st?.status === "running"}
                    style={{ fontSize: 11, fontWeight: 600, padding: "5px 10px", borderRadius: 7, border: "1px solid #CDE9FB", background: "#FFFFFF", color: "#0369A1", cursor: st?.status === "running" ? "default" : "pointer", opacity: st?.status === "running" ? 0.6 : 1 }}>
                    Mine PR history
                  </button>
                </div>
              );
            })
          )}
        </div>

        {annotations.length > 0 && (
          <div style={{ border: "1px solid #E1EBF5", borderRadius: 10, padding: 14, marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13.5, fontWeight: 700, color: "#0F2540" }}>
                <ShieldCheck size={14} /> Pending annotations
              </div>
              <span style={{ fontSize: 11, color: "#5B7290", background: "#F3F8FD", padding: "2px 8px", borderRadius: 99 }}>{annotations.length}</span>
            </div>
            <p style={{ fontSize: 11, color: "#7B8FA8", margin: "0 0 8px" }}>
              Notes proposed by an MCP client (Claude Code, Cursor, etc.) via the <code>annotate_node</code> tool. Nothing changes on the graph until you approve one.
            </p>
            {annotations.map((a) => (
              <div key={a.id} style={{ padding: "8px 0", borderTop: "1px solid #F0F4F9" }}>
                <div style={{ fontSize: 11.5, fontFamily: "'IBM Plex Mono', monospace", color: "#0F2540", marginBottom: 3 }}>{a.node_id}</div>
                <div style={{ fontSize: 12, color: "#3A4E68", marginBottom: 6 }}>{a.note}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 10, color: "#93A7BF", flex: 1 }}>proposed by {a.author}</span>
                  <button onClick={() => decideAnnotation(a.id, "approve")} style={{ fontSize: 11, fontWeight: 600, padding: "4px 9px", borderRadius: 6, border: "none", background: "#0F7B4E", color: "white", cursor: "pointer" }}>Approve</button>
                  <button onClick={() => decideAnnotation(a.id, "reject")} style={{ fontSize: 11, fontWeight: 600, padding: "4px 9px", borderRadius: 6, border: "1px solid #E1EBF5", background: "#FFFFFF", color: "#5B7290", cursor: "pointer" }}>Reject</button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div style={{ border: "1px solid #E1EBF5", borderRadius: 10, padding: 14, marginBottom: 16, background: "#FBFDFF" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13.5, fontWeight: 700, color: "#0F2540", marginBottom: 6 }}>
            <Terminal size={14} /> MCP server (Claude Code / Cursor / etc.)
          </div>
          <p style={{ fontSize: 11, color: "#7B8FA8", margin: "0 0 6px" }}>
            This app ships <code>backend/mcp_server.py</code>, a standalone MCP server exposing the last analysis run (debt summary, module narratives, blast-radius queries, PR insights, and a grounded Q&amp;A tool) to any MCP-speaking agent — it reads the same on-disk data this dashboard does and doesn't require this web server to be running.
          </p>
          <p style={{ fontSize: 11, color: "#7B8FA8", margin: 0 }}>
            Point your MCP client at <code>python3 backend/mcp_server.py</code> over stdio. Its one write tool, <code>annotate_node</code>, only ever proposes a note here for you to approve — see "Pending annotations" above.
          </p>
        </div>

        {PROVIDER_ORDER.map((p) => {
          const meta = settings.providers[p];
          const active = settings.active_provider === p;
          return (
            <div key={p} style={{ border: active ? "1.5px solid #0EA5E9" : "1px solid #E1EBF5", background: active ? "#F0F9FF" : "#FFFFFF", borderRadius: 10, padding: 14, marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
                <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13.5, fontWeight: 700, color: "#0F2540" }}>
                  <input type="radio" name="provider" checked={active} onChange={() => setSettings((s) => ({ ...s, active_provider: p }))} />
                  {meta.label}
                </label>
                {p === "ollama" ? (
                  <span style={{ fontSize: 11, color: "#5B3FA8", background: "#F1ECFB", padding: "2px 8px", borderRadius: 99 }}>runs locally — no key needed</span>
                ) : meta.has_key ? (
                  <span style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#0F7B4E", background: "#E7F9F1", padding: "2px 8px", borderRadius: 99 }}><Check size={11} /> key set{meta.key_preview ? ` (${meta.key_preview})` : ""}</span>
                ) : (
                  <span style={{ fontSize: 11, color: "#B45309", background: "#FEF3E2", padding: "2px 8px", borderRadius: 99 }}>no key yet</span>
                )}
              </div>
              <p style={{ fontSize: 11, color: "#7B8FA8", margin: "0 0 8px" }}>{PROVIDER_NOTES[p]}</p>
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  value={form[p]?.model || ""} onChange={(e) => setForm((f) => ({ ...f, [p]: { ...f[p], model: e.target.value } }))}
                  placeholder="model name" style={{ flex: 1, padding: "7px 10px", borderRadius: 7, border: "1px solid #DCEAF6", fontSize: 12, fontFamily: "'IBM Plex Mono', monospace" }}
                />
                {p === "ollama" ? (
                  <input
                    value={form.ollama?.base_url || ""} onChange={(e) => setForm((f) => ({ ...f, ollama: { ...f.ollama, base_url: e.target.value } }))}
                    placeholder="http://localhost:11434/v1" style={{ flex: 1.4, padding: "7px 10px", borderRadius: 7, border: "1px solid #DCEAF6", fontSize: 12, fontFamily: "'IBM Plex Mono', monospace" }}
                  />
                ) : (
                  <div style={{ flex: 1.4, position: "relative" }}>
                    <Key size={12} style={{ position: "absolute", left: 9, top: 9, color: "#B7CDE3" }} />
                    <input
                      type="password" value={form[p]?.api_key || ""} onChange={(e) => setForm((f) => ({ ...f, [p]: { ...f[p], api_key: e.target.value } }))}
                      placeholder={meta.has_key ? "leave blank to keep existing key" : "paste API key"}
                      style={{ width: "100%", boxSizing: "border-box", padding: "7px 10px 7px 26px", borderRadius: 7, border: "1px solid #DCEAF6", fontSize: 12 }}
                    />
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {stats && (stats.up + stats.down > 0) && (
          <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 12, color: "#5B7290", background: "#F3F8FD", border: "1px solid #DCEAF6", borderRadius: 9, padding: "10px 12px", marginBottom: 16 }}>
            <span style={{ fontWeight: 700, color: "#0F2540" }}>Chat feedback so far</span>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}><ThumbsUp size={12} color="#0EA5E9" /> {stats.up}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 4 }}><ThumbsDown size={12} color="#DC2626" /> {stats.down}</span>
            <span style={{ color: "#93A7BF" }}>· recent down-voted answers are shown to the model as examples to avoid repeating</span>
          </div>
        )}

        <button onClick={save} disabled={saving}
          style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: 7, padding: "11px 0", background: saved ? "#10B981" : "#0EA5E9", color: "white", border: "none", borderRadius: 9, fontSize: 13.5, fontWeight: 700, cursor: "pointer", opacity: saving ? 0.7 : 1 }}>
          {saving ? <><Loader2 size={14} className="spin" /> Saving…</> : saved ? <><Check size={14} /> Saved</> : "Save settings"}
        </button>
      </div>
      <style>{`.spin { animation: adminSpin 1s linear infinite; } @keyframes adminSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
