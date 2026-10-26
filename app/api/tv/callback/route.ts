import { NextResponse } from "next/server";
import { finishTvLogin, originOf } from "@/lib/tradingview";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const origin = originOf(req);
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const denied = url.searchParams.get("error");
  if (!code) {
    return NextResponse.redirect(new URL(`/?tv_error=${encodeURIComponent(denied ?? "TradingView login was cancelled.")}`, origin), 303);
  }
  try {
    await finishTvLogin(origin, code, url.searchParams.get("state"));
    return NextResponse.redirect(new URL("/", origin), 303);
  } catch (err) {
    return NextResponse.redirect(new URL(`/?tv_error=${encodeURIComponent((err as Error).message.slice(0, 200))}`, origin), 303);
  }
}
