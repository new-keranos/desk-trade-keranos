import "server-only";
import { TV, type TvCaller } from "../tradingview";
import { SNAP_COLS, snapOf, type Snap } from "./prefilter";
import { PREV_COLS, prevOf, type PrevBar } from "./tracker";
import { indOf, SCREEN_COLS, type Ind } from "./screen";

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

type Row = Stock & Record<string, unknown>;
/** Columns per screener call. TradingView caps a tool result at 1 MB; S&P 500 with all ~50 columns came to
 * 1.5 MB (2026-11-12), so the columns are split over a few calls (same market and order) and joined by symbol. */
const COLS_PER_CALL = 16;
const tooBig = (err: unknown) => /exceeds limit/i.test((err as Error)?.message ?? "");

async function screenerRows(tv: TvCaller, universe: UniverseId, cols: string[]): Promise<Row[]> {
  const call = async (columns: string[]): Promise<Row[]> => {
    try {
      const res = (await tv(TV.screener, { ...UNIVERSES[universe].args, columns: ["name", ...columns.filter((c) => c !== "name")],
        sort_by: "market_cap_basic", sort_order: "desc", limit: 1000 })) as { data?: { rows?: Row[] } };
      return (res?.data?.rows ?? []).filter((r) => r.symbol);
    } catch (err) {
      // Still too large: split this part in two.
      if (tooBig(err) && columns.length > 2) { const h = Math.ceil(columns.length / 2); return join([await call(columns.slice(0, h)), await call(columns.slice(h))]); }
      throw err;
    }
  };
  const parts: Row[][] = [];
  for (let k = 0; k < cols.length; k += COLS_PER_CALL) parts.push(await call(cols.slice(k, k + COLS_PER_CALL)));
  return join(parts);
}

/** Rows of several calls joined by symbol, in the first call's order. */
function join(parts: Row[][]): Row[] {
  if (parts.length === 1) return parts[0];
  const by = new Map<string, Row>();
  for (const part of parts) for (const r of part) by.set(r.symbol as string, { ...(by.get(r.symbol as string) ?? {}), ...r } as Row);
  return parts[0].map((r) => by.get(r.symbol as string)!);
}

/** Members of the universe that match any of the themes (all members when no theme), largest first, with each
 * one's prefilter snapshot and its last completed daily bars (for the pattern detector). A few run_screener calls
 * (the columns split to stay under TradingView's 1 MB result cap) read the whole market and all of these together. */
export async function loadUniverse(tv: TvCaller, universe: UniverseId, themes: ThemeId[]): Promise<{ stocks: Stock[]; total: number; snaps: Record<string, Snap>; prev: Record<string, PrevBar>; inds: Record<string, Ind> }> {
  const rows = await screenerRows(tv, universe, [...new Set([...BASE_COLS, ...SNAP_COLS, ...PREV_COLS, ...SCREEN_COLS])]);
  const picked = themes.length ? rows.filter((s) => themes.some((t) => inTheme(s, THEMES[t]))) : rows;
  const snaps: Record<string, Snap> = {}, prev: Record<string, PrevBar> = {}, inds: Record<string, Ind> = {};
  const stocks: Stock[] = picked.map((r) => {
    snaps[r.symbol] = snapOf(r);
    inds[r.symbol] = indOf(r);
    const p = prevOf(r);
    if (p) prev[r.symbol] = p;
    const { symbol, name, description, close, change, sector, industry, market_cap_basic } = r;
    return { symbol, name, description, close, change, sector, industry, market_cap_basic };
  });
  return { stocks, total: rows.length, snaps, prev, inds };
}
