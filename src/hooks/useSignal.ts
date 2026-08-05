import { useState, useEffect } from "react";
import { engine, Signal } from "../core/engine";

export function useSignal(assetId: string) {
  const [signal, setSignal] = useState<Signal | null>(null);

  useEffect(() => {
    const interval = setInterval(() => {
      setSignal(engine.getSignal(assetId) || null);
    }, 100);
    return () => clearInterval(interval);
  }, [assetId]);

  return signal;
}
