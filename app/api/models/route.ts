import { availableModels, defaultChoice } from "@/lib/nova/config";

export const dynamic = "force-dynamic";

/** The AI models this server has keys for, for the model picker. */
export function GET() {
  return Response.json({ models: availableModels(), default: defaultChoice() });
}
