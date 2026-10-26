import { ApiError } from "@google/genai";
import { z } from "zod";
import { N, normalize } from "@/lib/scan/match";
import { runScan, type ScanEvent } from "@/lib/scan/run";
import { shapeFromImage, ShapeError } from "@/lib/scan/shape";
import { sampleAnchors, templateById } from "@/lib/scan/templates";
import { THEMES, UNIVERSES, type ThemeId, type UniverseId } from "@/lib/scan/universe";
import { openTv, originOf, TvAuthError } from "@/lib/tradingview";

export const runtime = "nodejs";
export const maxDuration = 300;

const Body = z.object({
  universe: z.enum(Object.keys(UNIVERSES) as [UniverseId, ...UniverseId[]]),
  themes: z.array(z.enum(Object.keys(THEMES) as [ThemeId, ...ThemeId[]])).max(5).default([]),
  length: z.enum(["short", "medium", "long"]).default("medium"),
  pattern: z.union([
    z.object({ template: z.string().max(40) }),
    // The browser downsizes images first; about 1.5 MB of base64 is plenty for a pattern.
    z.object({ image: z.object({ mime: z.enum(["image/jpeg", "image/png", "image/webp"]), data: z.string().min(100).max(1_500_000) }) }),
  ]),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Bad request" }, { status: 400 });
  const { universe, themes, length, pattern } = parsed.data;
  const template = "template" in pattern ? templateById(pattern.template) : undefined;
  if ("template" in pattern && !template) return Response.json({ error: "Unknown pattern" }, { status: 400 });

  // Open TradingView before streaming: a token refresh may need to update the login cookie.
  let tv: Awaited<ReturnType<typeof openTv>>;
  try {
    tv = await openTv(originOf(req));
  } catch (err) {
    return Response.json({ error: (err as Error).message, connect: err instanceof TvAuthError }, { status: err instanceof TvAuthError ? 409 : 502 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (e: ScanEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      try {
        let shape: number[];
        if (template) {
          shape = normalize(sampleAnchors(template.anchors, N));
        } else {
          emit({ type: "status", text: "Reading the pattern in your image" });
          const s = await shapeFromImage((pattern as { image: Parameters<typeof shapeFromImage>[0] }).image, req.signal);
          emit({ type: "shape", ...s });
          shape = s.points;
        }
        await runScan({ tv: tv.call, universe, themes, length, shape, template, signal: req.signal }, emit);
      } catch (err) {
        let message = "The scan was interrupted. Try again.";
        if (err instanceof ShapeError) message = err.message;
        else if (err instanceof ApiError) message = err.status === 429 ? "Gemini free-tier limit reached while reading the image. Wait a minute and try again." : `Gemini couldn't read the image (error ${err.status}).`;
        else if (err instanceof Error && err.message.includes("TradingView")) message = err.message;
        emit({ type: "error", message });
      } finally {
        emit({ type: "done" });
        controller.close();
        await tv.close();
      }
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
