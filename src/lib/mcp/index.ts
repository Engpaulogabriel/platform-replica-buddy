// Entry point for the app-hosted MCP server (bundled to
// supabase/functions/mcp/index.ts by @lovable.dev/mcp-js/stacks/supabase/vite).
//
// IMPORTANT: keep this file import-safe. No top-level env reads, no I/O, no
// throws. Read env inside tool handlers.

import { auth, defineMcp } from "@lovable.dev/mcp-js";

import whoamiTool from "./tools/whoami";
import listFarmsTool from "./tools/list-farms";
import listEquipmentsTool from "./tools/list-equipments";
import listNotificationsTool from "./tools/list-notifications";

// The OAuth issuer must be the direct Supabase host, built from the project
// ref (never from SUPABASE_URL, which can be the .lovable.cloud proxy). Vite
// inlines VITE_SUPABASE_PROJECT_ID as a literal at build time, so this stays
// import-safe.
const projectRef =
  (import.meta as any).env?.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "renov-gestor-bombas-mcp",
  title: "RENOV Gestor de Bombas",
  version: "0.1.0",
  instructions:
    "Ferramentas de leitura do RENOV Gestor de Bombas: listar fazendas do usuário, equipamentos por fazenda e notificações/alarmes recentes. Todas as chamadas respeitam RLS e agem como o usuário autenticado. Use `whoami` para confirmar a conexão.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [whoamiTool, listFarmsTool, listEquipmentsTool, listNotificationsTool],
});
