import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser, unauthenticated } from "../supabase";

export default defineTool({
  name: "list_equipments",
  title: "Listar equipamentos de uma fazenda",
  description:
    "Retorna bombas/poços/reservatórios cadastrados na fazenda informada, com estado atual e horário da última atualização.",
  inputSchema: {
    farm_id: z.string().uuid().describe("UUID da fazenda (use list_farms para obter)."),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ farm_id }, ctx) => {
    if (!ctx.isAuthenticated()) return unauthenticated();
    const sb = supabaseForUser(ctx);
    const { data, error } = await sb
      .from("equipments")
      .select("id, name, type, hw_id, status, last_outputs_state, updated_at")
      .eq("farm_id", farm_id)
      .order("name", { ascending: true })
      .limit(200);
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? []) }],
      structuredContent: { equipments: data ?? [] },
    };
  },
});
