import { NextResponse } from "next/server";
import { beginTvLogin, originOf } from "@/lib/tradingview";

export const runtime = "nodejs";

// Sends the browser to TradingView's login, or home when already connected.
export async function GET(req: Request) {
  const origin = originOf(req);
  try {
    const url = await beginTvLogin(origin);
    return NextResponse.redirect(url ?? new URL("/", origin), 303);
  } catch (err) {
    return NextResponse.redirect(new URL(`/?tv_error=${encodeURIComponent((err as Error).message.slice(0, 200))}`, origin), 303);
  }
}
