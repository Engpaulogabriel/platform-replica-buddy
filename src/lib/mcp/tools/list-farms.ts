import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser, unauthenticated } from "../supabase";

export default defineTool({
  name: "list_farms",
  title: "Listar fazendas do usuário",
  description:
    "Retorna todas as fazendas às quais o usuário autenticado tem acesso (id, nome e status).",
  inputSchema: {},
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async (_input, ctx) => {
    if (!ctx.isAuthenticated()) return unauthenticated();
    const sb = supabaseForUser(ctx);
    const { data, error } = await sb
      .from("farms")
      .select("id, name, created_at")
      .order("name", { ascending: true });
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? []) }],
      structuredContent: { farms: data ?? [] },
    };
  },
});

// This tool intentionally ignores any user_id input — the user is derived
// from the verified OAuth token via RLS.
export const _z = z;
