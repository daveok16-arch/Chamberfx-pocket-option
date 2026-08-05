import React, { useState, useEffect } from "react";
import { DecisionObject } from "./types";
import { ChamberFXPanel } from "./components/ChamberFXPanel";
import { useStrategyStore } from "./store/strategyStore";

export default function App() {
  const [systemConnected, setSystemConnected] = useState<boolean>(true);
  const store = useStrategyStore();
  
  const [decision, setDecision] = useState<DecisionObject>({
    asset: null,
    direction: "WAIT",
    confidence: 0,
    timeframe: "1 Minute",
    entryWindow: "Awaiting scan",
    signalStatus: "SCANNING",
    reasoning: ["Scanning markets for high probability setup..."],
    risk: "MODERATE",
    countdown: 0,
    aiValidated: false,
    generatedAt: new Date().toISOString()
  });

  // Fetch telemetry & rankings state periodically from Express container (1s tick)
  const fetchState = async () => {
    try {
      const res = await fetch(`/api/state?preferredModelId=gemini-3.5-flash-free&operationalMode=QUANTITATIVE`);
      if (!res.ok) throw new Error("Telemetry connection lost");
      const contentType = res.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        const data = await res.json();
        setSystemConnected(data.connected);
        if (data.decisionObject) {
          setDecision(data.decisionObject);
          store.setDecision(data.decisionObject);
        }
      }
    } catch (err) {
      setSystemConnected(false);
    }
  };

  useEffect(() => {
    fetchState();
    const interval = setInterval(fetchState, 1000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="w-screen h-screen m-0 p-0 overflow-hidden bg-[#000000] text-white font-sans selection:bg-emerald-500/20 selection:text-emerald-400 flex flex-col" id="app-root-container">
      <ChamberFXPanel decision={decision} onRefreshState={fetchState} />
    </div>
  );
}
