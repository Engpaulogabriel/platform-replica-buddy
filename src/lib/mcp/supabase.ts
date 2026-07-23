// Helper: Supabase client scoped to the MCP user's bearer token so RLS runs
// as that user. Env vars are read INSIDE the handler at request time so this
// file stays import-safe (no top-level env reads / throws).
import { createClient } from "@supabase/supabase-js";
import type { ToolContext } from "@lovable.dev/mcp-js";

export function supabaseForUser(ctx: ToolContext) {
  const url = process.env.SUPABASE_URL;
  const anon = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error("Supabase env vars are not configured");
  return createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${ctx.getToken()}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function unauthenticated() {
  return {
    content: [{ type: "text" as const, text: "Not authenticated. Sign in and try again." }],
    isError: true as const,
  };
}
