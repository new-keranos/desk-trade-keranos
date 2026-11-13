import { z } from "zod";
import { cachedJson } from "@/lib/scan/cache";
import { EARLY_COLS, earlySetup, type EarlyRow } from "@/lib/scan/early";
import { screenerRows, UNIVERSES, type UniverseId } from "@/lib/scan/universe";
import { openTv, originOf, TvAuthError, TvQuotaError, TvRetryError } from "@/lib/tradingview";

export const runtime = "nodejs";
export const maxDuration = 60;

const Body = z.object({ universe: z.enum(Object.keys(UNIVERSES) as [UniverseId, ...UniverseId[]]) });
/** The user presses Scan for fresh data; this only stops repeated presses from re-reading the market. */
const TTL_S = 5 * 60;

export type EarlyResult = { rows: EarlyRow[]; total: number; at: string; universe: UniverseId };

/** Early bullish-divergence scan, run when the user presses Scan: the whole market from one or two run_screener
 * calls (no chart calls, no AI).
 * Liquidity and relative-volume thresholds are applied in the browser so they can change without a new call. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Bad request" }, { status: 400 });
  const { universe } = parsed.data;
  let tv: Awaited<ReturnType<typeof openTv>> | undefined;
  try {
    tv = await openTv(originOf(req));
    const call = tv.call;
    const result = await cachedJson<EarlyResult>(`early1:${universe}`, async () => {
      const rows = await screenerRows(call, universe, [...EARLY_COLS]);
      const picks = rows.map((r) => earlySetup(r)).filter((r): r is EarlyRow => !!r).sort((a, b) => b.score - a.score);
      return { rows: picks, total: rows.length, at: new Date().toISOString(), universe };
    }, TTL_S);
    return Response.json(result);
  } catch (err) {
    if (err instanceof TvQuotaError) return Response.json({ error: err.message, quota: true, until: err.until }, { status: 429 });
    if (err instanceof TvRetryError) return Response.json({ error: "TradingView login didn't refresh. Log in to TradingView again.", relogin: true }, { status: 503 });
    return Response.json({ error: (err as Error).message, connect: err instanceof TvAuthError }, { status: err instanceof TvAuthError ? 409 : 502 });
  } finally {
    await tv?.close();
  }
}
