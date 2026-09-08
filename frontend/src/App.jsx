import React, { useState, useEffect, useRef } from "react";
import SetupScreen from "./SetupScreen";
import WaitingShell from "./WaitingShell";
import Dashboard from "./Dashboard";

export default function App() {
  const [data, setData] = useState(null);
  const [checked, setChecked] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [jobRunning, setJobRunning] = useState(false);
  const [jobStep, setJobStep] = useState("");
  const [jobError, setJobError] = useState(null);
  const [justCompleted, setJustCompleted] = useState(false);
  const pollRef = useRef(null);

  // Single poller shared by "first ever analysis" and "New analysis from an
  // existing dashboard" — the whole point of backgrounding the run is that
  // neither case should block the UI on a spinner-only screen.
  function startPolling() {
    if (pollRef.current) return; // already polling
    pollRef.current = setInterval(async () => {
      try {
        const s = await fetch("/api/status").then((r) => r.json());
        setJobStep(s.step);
        if (s.status === "done") {
          clearInterval(pollRef.current);
          pollRef.current = null;
          const fresh = await fetch("/api/metrics").then((r) => r.json());
          setData(fresh);
          setJobRunning(false);
          setJustCompleted(true);
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            new Notification("Tech Debt Radar", { body: `Analysis of ${fresh.repo || "your codebase"} is ready.` });
          }
        } else if (s.status === "error") {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setJobRunning(false);
          setJobError(s.error || "The analysis failed.");
        }
      } catch {
        // transient fetch failure — keep polling, the backend job is unaffected
      }
    }, 1200);
  }

  useEffect(() => {
    Promise.all([
      fetch("/api/metrics").then((r) => r.json()).catch(() => ({ ready: false })),
      fetch("/api/status").then((r) => r.json()).catch(() => ({ status: "idle" })),
    ]).then(([metricsRes, statusRes]) => {
      if (metricsRes.ready) setData(metricsRes);
      if (statusRes.status === "running") {
        // e.g. the page was reloaded mid-analysis — resume watching it
        // instead of dropping back to the setup form.
        setJobRunning(true);
        setJobStep(statusRes.step || "");
        startPolling();
      }
      setChecked(true);
    });
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  function handleStarted() {
    setShowSetup(false);
    setJobRunning(true);
    setJobError(null);
    setJustCompleted(false);
    startPolling();
  }

  if (!checked) return null;

  if (showSetup || (!data && !jobRunning)) {
    return <SetupScreen onStarted={handleStarted} />;
  }
  if (!data && jobRunning) {
    return <WaitingShell step={jobStep} />;
  }
  return (
    <Dashboard
      data={data}
      jobRunning={jobRunning}
      jobStep={jobStep}
      jobError={jobError}
      justCompleted={justCompleted}
      onDismissComplete={() => setJustCompleted(false)}
      onDismissError={() => setJobError(null)}
      onReanalyze={() => setShowSetup(true)}
    />
  );
}
