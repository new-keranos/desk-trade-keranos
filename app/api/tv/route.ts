import { NextResponse } from "next/server";
import { callTv, READ_TOOLS, WRITE_TOOLS, TvError } from "@/lib/tradingview";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { tool?: unknown; input?: unknown } | null;
  const tool = typeof body?.tool === "string" ? body.tool : "";
  const input = body?.input && typeof body.input === "object" ? (body.input as Record<string, unknown>) : {};
  if (!READ_TOOLS.has(tool) && !WRITE_TOOLS.has(tool)) {
    return NextResponse.json({ error: `Tool not allowed: ${tool}` }, { status: 400 });
  }
  try {
    const data = await callTv(tool, input);
    return NextResponse.json({ data });
  } catch (err) {
    const status = err instanceof TvError ? 502 : 500;
    return NextResponse.json({ error: (err as Error).message }, { status });
  }
}
