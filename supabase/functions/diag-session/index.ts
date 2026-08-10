// diag-session — Acesso Remoto do renov_diag (terminal serial remoto).
// ───────────────────────────────────────────────────────────────────────────
// Chamada pela FERRAMENTA (renov_diag). Gated pelo par code+machine_id (segredo
// da sessão, código de 8 dígitos, 30 min). service_role internamente.
//   action=create  { code, machine_id, com_port }  → abre a sessão
//   action=poll    { code, machine_id }             → devolve comandos pendentes (marca 'sent')
//   action=respond { code, machine_id, command_id, response } → grava a resposta
//   action=close   { code, machine_id }             → encerra a sessão
// A WEB (platform_admin) enfileira comandos e lê respostas DIRETO nas tabelas
// (RLS platform_admin) — não passa por aqui.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const json = (b: unknown, s = 200) =>
    new Response(JSON.stringify(b), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  let body: any = {};
  try { body = await req.json(); } catch { /* vazio */ }
  const action = String(body?.action ?? "");
  const code = String(body?.code ?? "").trim();
  const machineId = String(body?.machine_id ?? "").trim();
  if (!/^\d{8}$/.test(code) || !machineId) return json({ ok: false, reason: "missing_params" }, 400);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const nowIso = new Date().toISOString();

  if (action === "create") {
    // upsert por code (idempotente se a ferramenta reabrir com o mesmo código)
    const { error } = await supabase.from("diag_sessions").upsert({
      code, machine_id: machineId, com_port: String(body?.com_port ?? "") || null,
      status: "active", last_poll_at: nowIso,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    }, { onConflict: "code" });
    if (error) return json({ ok: false, reason: error.message }, 500);
    return json({ ok: true });
  }

  // sessão válida (ativa, não expirada, mesma máquina) para as demais ações
  const { data: sess } = await supabase
    .from("diag_sessions").select("id, status, expires_at, machine_id")
    .eq("code", code).maybeSingle();
  if (!sess || sess.machine_id !== machineId) return json({ ok: false, reason: "not_found" }, 404);
  if (sess.status !== "active") return json({ ok: false, reason: "closed" }, 410);
  if (new Date(sess.expires_at).getTime() < Date.now()) {
    await supabase.from("diag_sessions").update({ status: "expired" }).eq("id", sess.id);
    return json({ ok: false, reason: "expired" }, 410);
  }

  if (action === "poll") {
    await supabase.from("diag_sessions").update({ last_poll_at: nowIso }).eq("id", sess.id);
    const { data: cmds } = await supabase
      .from("diag_commands").select("id, command")
      .eq("session_id", sess.id).eq("status", "pending")
      .order("created_at", { ascending: true }).limit(10);
    const ids = (cmds ?? []).map((c: any) => c.id);
    if (ids.length) {
      await supabase.from("diag_commands").update({ status: "sent", sent_at: nowIso }).in("id", ids);
    }
    return json({ ok: true, commands: cmds ?? [] });
  }

  if (action === "respond") {
    const cmdId = String(body?.command_id ?? "");
    if (!cmdId) return json({ ok: false, reason: "missing_command_id" }, 400);
    await supabase.from("diag_commands").update({
      status: "done", response: String(body?.response ?? ""), responded_at: nowIso,
    }).eq("id", cmdId).eq("session_id", sess.id);
    return json({ ok: true });
  }

  if (action === "close") {
    await supabase.from("diag_sessions").update({ status: "closed" }).eq("id", sess.id);
    return json({ ok: true });
  }

  return json({ ok: false, reason: "unknown_action" }, 400);
});
