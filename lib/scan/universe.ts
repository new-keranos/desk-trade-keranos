import "server-only";
import { TV, type TvCaller } from "../tradingview";

// Markets the scanner can search, as TradingView screener arguments.
export const UNIVERSES = {
  SP500: { label: "S&P 500", args: { market: "america", filters: { index: "S&P 500" } } },
  NDX: { label: "Nasdaq 100", args: { market: "america", filters: { index: "Nasdaq 100" } } },
  SET50: { label: "SET50", args: { market: "thailand", symbolset: ["SYML:SET;SET50"] } },
  SET100: { label: "SET100", args: { market: "thailand", symbolset: ["SYML:SET;SET100"] } },
} as const;
export type UniverseId = keyof typeof UNIVERSES;

type Theme = { label: string; sectors?: string[]; industries?: string[]; excludeIndustries?: string[]; tickers?: string[] };

// Themes map to TradingView sectors and industries. A stock matches a theme if any rule matches.
// TradingView has no fintech sector, so Fintech is a hand-picked list of payment, broker and digital-lending names.
export const THEMES: Record<string, Theme> = {
  TECH: { label: "Tech", sectors: ["Technology Services", "Electronic Technology"] },
  MEDICAL: { label: "Medical", sectors: ["Health Technology", "Health Services"] },
  FINANCE: { label: "Finance", sectors: ["Finance"], excludeIndustries: ["Real Estate Development", "Real Estate Investment Trusts"] },
  ENERGY: { label: "Energy", sectors: ["Energy Minerals", "Utilities"], industries: ["Oilfield Services/Equipment", "Oil & Gas Pipelines", "Contract Drilling"] },
  FINTECH: { label: "Fintech", tickers: [
    "V", "MA", "PYPL", "XYZ", "FISV", "FIS", "GPN", "CPAY", "JKHY", "COIN", "HOOD", "SOFI", "AFRM", "INTU", "TOST", "NU", "MELI", "SCHW", "IBKR", "AXP",
    "KTC", "AEONTS", "MTC", "SAWAD", "TIDLOR", "JMT", "BAM",
  ] },
};
export type ThemeId = keyof typeof THEMES;

export type Stock = { symbol: string; name: string; description?: string; close?: number; change?: number; sector?: string; industry?: string; market_cap_basic?: number };

function inTheme(s: Stock, t: Theme): boolean {
  if (t.tickers?.includes(s.name)) return true;
  if (s.industry && t.excludeIndustries?.includes(s.industry)) return false;
  return !!((s.sector && t.sectors?.includes(s.sector)) || (s.industry && t.industries?.includes(s.industry)));
}

/** Members of the universe that match any of the themes (all members when no theme), largest first. */
export async function loadUniverse(tv: TvCaller, universe: UniverseId, themes: ThemeId[]): Promise<{ stocks: Stock[]; total: number }> {
  const res = (await tv(TV.screener, {
    ...UNIVERSES[universe].args,
    columns: ["name", "description", "close", "change", "sector", "industry", "market_cap_basic"],
    sort_by: "market_cap_basic", sort_order: "desc", limit: 600,
  })) as { data?: { rows?: Stock[] } };
  const rows = (res?.data?.rows ?? []).filter((r) => r.symbol);
  const stocks = themes.length ? rows.filter((s) => themes.some((t) => inTheme(s, THEMES[t]))) : rows;
  return { stocks, total: rows.length };
}
