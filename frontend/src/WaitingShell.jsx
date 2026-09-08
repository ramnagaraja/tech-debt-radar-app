import React from "react";
import { Loader2, Flame, BellRing } from "lucide-react";
import { STEP_LABELS } from "./SetupScreen";

// Shown only for a first-ever analysis (no previous dashboard to keep
// displaying) while the run happens on a background thread server-side —
// this screen is informational, never blocking: nothing here disables
// navigation, and closing the tab doesn't stop the analysis, it just stops
// this page from being able to tell you when it's done.
export default function WaitingShell({ step }) {
  return (
    <div style={{ minHeight: "100vh", background: "#F5F9FD", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Inter, system-ui, sans-serif", padding: 20 }}>
      <div style={{ width: 480, background: "#FFFFFF", border: "1px solid #E1EBF5", borderRadius: 16, padding: 32, textAlign: "center" }}>
        <div style={{ width: 44, height: 44, borderRadius: 10, background: "#0EA5E9", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
          <Flame size={22} color="white" />
        </div>
        <div style={{ fontSize: 16, fontWeight: 700, color: "#0F2540", marginBottom: 6 }}>Analyzing in the background</div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8, fontSize: 13, color: "#5B7290", marginBottom: 18 }}>
          <Loader2 size={15} className="spin" /> {STEP_LABELS[step] || "Working…"}
        </div>
        <p style={{ fontSize: 12.5, color: "#7B8FA8", lineHeight: 1.6, marginBottom: 0 }}>
          This can take a while for a large codebase or database — you don't need to
          keep watching. Leave this tab open in the background (or another tab) and
          we'll show a notification the moment it's ready, or just come back and
          reopen this page later to see the finished dashboard.
        </p>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 11.5, color: "#93A7BF", marginTop: 14 }}>
          <BellRing size={12} /> {typeof Notification !== "undefined" && Notification.permission === "granted" ? "You'll get a browser notification when it's done." : "Notifications weren't enabled — check back here to see progress."}
        </div>
        <style>{`.spin { animation: spin 1s linear infinite; } @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
      </div>
    </div>
  );
}
