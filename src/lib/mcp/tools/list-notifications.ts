import { defineTool } from "@lovable.dev/mcp-js";
import { z } from "zod";
import { supabaseForUser, unauthenticated } from "../supabase";

export default defineTool({
  name: "list_recent_notifications",
  title: "Listar notificações/alarmes recentes",
  description:
    "Retorna as notificações/alertas mais recentes de uma fazenda (padrão: últimas 20).",
  inputSchema: {
    farm_id: z.string().uuid().describe("UUID da fazenda."),
    limit: z
      .number()
      .int()
      .min(1)
      .max(100)
      .describe("Quantas notificações retornar (1–100).")
      .default(20),
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  handler: async ({ farm_id, limit }, ctx) => {
    if (!ctx.isAuthenticated()) return unauthenticated();
    const sb = supabaseForUser(ctx);
    const { data, error } = await sb
      .from("farm_notifications")
      .select("id, title, message, severity, created_at, equipment_id")
      .eq("farm_id", farm_id)
      .order("created_at", { ascending: false })
      .limit(limit ?? 20);
    if (error) return { content: [{ type: "text", text: error.message }], isError: true };
    return {
      content: [{ type: "text", text: JSON.stringify(data ?? []) }],
      structuredContent: { notifications: data ?? [] },
    };
  },
});
