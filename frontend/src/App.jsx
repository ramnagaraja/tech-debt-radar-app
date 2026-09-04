import React, { useState, useEffect } from "react";
import SetupScreen from "./SetupScreen";
import Dashboard from "./Dashboard";

export default function App() {
  const [data, setData] = useState(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    fetch("/api/metrics")
      .then((r) => r.json())
      .then((d) => { if (d.ready) setData(d); })
      .catch(() => {})
      .finally(() => setChecked(true));
  }, []);

  if (!checked) return null;
  if (!data) return <SetupScreen onReady={setData} />;
  return <Dashboard data={data} onReanalyze={() => setData(null)} />;
}
