// Edge function: cleanup-agent-logs
// ─────────────────────────────────────────────────────────────────────────────
// Apaga registros de `agent_logs` com mais de 7 dias.
// Disparada por pg_cron diariamente. Exige header `Authorization: Bearer <SERVICE_ROLE>`
// (ou CRON_SECRET) para impedir invocação pública.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function safeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const cronSecret = Deno.env.get("CRON_SECRET") ?? "";
  const authHeader = req.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();

  const isAuthorized =
    (serviceRole && safeEquals(token, serviceRole)) ||
    (cronSecret && safeEquals(token, cronSecret));

  if (!isAuthorized) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );

    const logsCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    // commands: manter histórico só das últimas 48h. Pending/processing órfãos
    // viram lixo na fila e degradam o `processNextCommand` do agente.
    const cmdCutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    // agent_commands: comandos remotos (open_port, list_ports, etc) — manter 24h
    const agentCmdCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const [logsRes, cmdRes, agentCmdRes] = await Promise.all([
      supabase.from("agent_logs").delete({ count: "exact" }).lt("created_at", logsCutoff),
      supabase.from("commands").delete({ count: "exact" }).lt("created_at", cmdCutoff),
      supabase.from("agent_commands").delete({ count: "exact" }).lt("created_at", agentCmdCutoff),
    ]);

    const firstError = logsRes.error || cmdRes.error || agentCmdRes.error;
    if (firstError) {
      console.error("cleanup failed:", firstError.message);
      return new Response(
        JSON.stringify({ ok: false, error: firstError.message }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        agent_logs_deleted: logsRes.count ?? 0,
        commands_deleted: cmdRes.count ?? 0,
        agent_commands_deleted: agentCmdRes.count ?? 0,
        logsCutoff,
        cmdCutoff,
        agentCmdCutoff,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (e) {
    console.error("cleanup-agent-logs exception:", e);
    return new Response(
      JSON.stringify({ ok: false, error: String((e as Error).message ?? e) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
