export interface AssetDefinition {
  id: string;
  name: string;
  ticker: string; // Yahoo Finance ticker equivalent
  payout: number;
}

export const AVAILABLE_ASSETS: AssetDefinition[] = [
  { id: "USDBRL_otc", name: "USD/BRL OTC", ticker: "USDBRL=X", payout: 0.92 },
  { id: "EURUSD_otc", name: "EUR/USD OTC", ticker: "EURUSD=X", payout: 0.92 },
  { id: "XAUUSD_otc", name: "GOLD OTC", ticker: "GC=F", payout: 0.92 },
  { id: "USDJPY_otc", name: "USD/JPY OTC", ticker: "USDJPY=X", payout: 0.91 },
  { id: "GBPUSD_otc", name: "GBP/USD OTC", ticker: "GBPUSD=X", payout: 0.90 },
  { id: "USDCAD_otc", name: "USD/CAD OTC", ticker: "USDCAD=X", payout: 0.90 },
  { id: "EURGBP_otc", name: "EUR/GBP OTC", ticker: "EURGBP=X", payout: 0.89 },
  { id: "AUDCAD_otc", name: "AUD/CAD OTC", ticker: "AUDCAD=X", payout: 0.88 },
  { id: "AUDUSD_otc", name: "AUD/USD OTC", ticker: "AUDUSD=X", payout: 0.88 }
];
