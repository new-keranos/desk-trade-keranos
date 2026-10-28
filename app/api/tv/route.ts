import { NextResponse } from "next/server";
import { openTv, originOf, READ_TOOLS, WRITE_TOOLS, TvAuthError, TvError, TvQuotaError, TvRetryError } from "@/lib/tradingview";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { tool?: unknown; input?: unknown } | null;
  const tool = typeof body?.tool === "string" ? body.tool : "";
  const input = body?.input && typeof body.input === "object" ? (body.input as Record<string, unknown>) : {};
  if (!READ_TOOLS.has(tool) && !WRITE_TOOLS.has(tool)) {
    return NextResponse.json({ error: `Tool not allowed: ${tool}` }, { status: 400 });
  }
  let tv;
  try {
    tv = await openTv(originOf(req));
    return NextResponse.json({ data: await tv.call(tool, input) });
  } catch (err) {
    if (err instanceof TvAuthError) return NextResponse.json({ error: err.message, connect: true }, { status: 409 });
    if (err instanceof TvQuotaError) return NextResponse.json({ error: err.message, quota: true, until: err.until }, { status: 429 });
    if (err instanceof TvRetryError) return NextResponse.json({ error: err.message, retry: true }, { status: 503 });
    return NextResponse.json({ error: (err as Error).message }, { status: err instanceof TvError ? 502 : 500 });
  } finally {
    await tv?.close();
  }
}
