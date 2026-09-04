import React, { useState, useEffect } from "react";
import { Settings, Key, Check, X, Loader2, ThumbsUp, ThumbsDown } from "lucide-react";

const PROVIDER_ORDER = ["anthropic", "gemini", "sarvam"];
const PROVIDER_NOTES = {
  anthropic: "Native Anthropic API.",
  gemini: "Via Gemini's OpenAI-compatible endpoint.",
  sarvam: "Via Sarvam AI's OpenAI-compatible endpoint — strong Indic-language support.",
};

export default function AdminPanel({ onClose }) {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({}); // { [provider]: { model, api_key } }
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [stats, setStats] = useState(null);

  useEffect(() => {
    fetch("/api/settings").then((r) => r.json()).then((s) => {
      setSettings(s);
      const f = {};
      for (const p of PROVIDER_ORDER) f[p] = { model: s.providers[p]?.model || "", api_key: "" };
      setForm(f);
    });
    fetch("/api/feedback/stats").then((r) => r.json()).then(setStats).catch(() => {});
  }, []);

  async function save() {
    setSaving(true);
    setSaved(false);
    const body = { active_provider: settings.active_provider };
    for (const p of PROVIDER_ORDER) {
      body[`${p}_model`] = form[p]?.model || undefined;
      body[`${p}_api_key`] = form[p]?.api_key || undefined;
    }
    const res = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (res.ok) {
      const fresh = await fetch("/api/settings").then((r) => r.json());
      setSettings(fresh);
      const f = {};
      for (const p of PROVIDER_ORDER) f[p] = { model: fresh.providers[p]?.model || "", api_key: "" };
      setForm(f);
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
            <Settings size={17} /> Admin — AI provider settings
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#93A7BF" }}><X size={18} /></button>
        </div>
        <p style={{ fontSize: 12.5, color: "#5B7290", marginTop: 0, marginBottom: 20 }}>
          Choose which model powers the Ask tab and dependency recommendations. Keys are stored locally in this app's own database, never sent anywhere except the provider you pick.
        </p>

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
                {meta.has_key ? (
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
                <div style={{ flex: 1.4, position: "relative" }}>
                  <Key size={12} style={{ position: "absolute", left: 9, top: 9, color: "#B7CDE3" }} />
                  <input
                    type="password" value={form[p]?.api_key || ""} onChange={(e) => setForm((f) => ({ ...f, [p]: { ...f[p], api_key: e.target.value } }))}
                    placeholder={meta.has_key ? "leave blank to keep existing key" : "paste API key"}
                    style={{ width: "100%", boxSizing: "border-box", padding: "7px 10px 7px 26px", borderRadius: 7, border: "1px solid #DCEAF6", fontSize: 12 }}
                  />
                </div>
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
          {saving ? <><Loader2 size={14} /> Saving…</> : saved ? <><Check size={14} /> Saved</> : "Save settings"}
        </button>
      </div>
    </div>
  );
}
