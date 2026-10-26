import { NextResponse } from "next/server";
import { disconnectTv, originOf } from "@/lib/tradingview";

export const runtime = "nodejs";

export async function POST(req: Request) {
  await disconnectTv();
  return NextResponse.redirect(new URL("/", originOf(req)), 303);
}
