// Session cookie = SHA-256 of APP_PASSWORD. Works in both the edge middleware and Node routes.
export const COOKIE = "keranos_session";

export async function sessionToken(): Promise<string | null> {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return null;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("keranos-desk:" + pw));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
