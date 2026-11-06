import "server-only";
import { TV, type TvCaller } from "../tradingview";
import { SNAP_COLS, snapOf, type Snap } from "./prefilter";
import { PREV_COLS, prevOf, type PrevBar } from "./tracker";

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

const BASE_COLS = ["name", "description", "close", "change", "sector", "industry", "market_cap_basic"];

/** Members of the universe that match any of the themes (all members when no theme), largest first, with each
 * one's prefilter snapshot and its last completed daily bars (for the pattern detector). One run_screener call
 * reads the whole market and all of these together. */
export async function loadUniverse(tv: TvCaller, universe: UniverseId, themes: ThemeId[]): Promise<{ stocks: Stock[]; total: number; snaps: Record<string, Snap>; prev: Record<string, PrevBar> }> {
  const res = (await tv(TV.screener, {
    ...UNIVERSES[universe].args,
    columns: [...new Set([...BASE_COLS, ...SNAP_COLS, ...PREV_COLS])],
    sort_by: "market_cap_basic", sort_order: "desc", limit: 1000,
  })) as { data?: { rows?: (Stock & Record<string, unknown>)[] } };
  const rows = (res?.data?.rows ?? []).filter((r) => r.symbol);
  const picked = themes.length ? rows.filter((s) => themes.some((t) => inTheme(s, THEMES[t]))) : rows;
  const snaps: Record<string, Snap> = {}, prev: Record<string, PrevBar> = {};
  const stocks: Stock[] = picked.map((r) => {
    snaps[r.symbol] = snapOf(r);
    const p = prevOf(r);
    if (p) prev[r.symbol] = p;
    const { symbol, name, description, close, change, sector, industry, market_cap_basic } = r;
    return { symbol, name, description, close, change, sector, industry, market_cap_basic };
  });
  return { stocks, total: rows.length, snaps, prev };
}
