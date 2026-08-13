// security-anomaly-watchdog — varredura periódica (pg_cron a cada 5 min).
// ───────────────────────────────────────────────────────────────────────────
// Regras (alerta WhatsApp aos super_admins, com dedup de 1h por usuário/regra).
// Limiares elevados 3x p/ login COMPARTILHADO (vários operadores, 1 conta):
//   • > 150 páginas DISTINTAS em 5 min → 'burst_navigation'
//   • > 15 PDFs em 10 min               → 'export_burst'
// (rate_limited 3x já é alertado inline no api-rate-limiter.)
// Fail-safe: qualquer erro só loga; nunca afeta a plataforma.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, jsonResp, alertSuperAdmins } from "../_shared/security.ts";

const MIN = 60_000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const now = Date.now();
  const alerted: string[] = [];

  // Já alertamos este usuário/regra na última 1h? (dedup via flag no activity log)
  const alertedRecently = async (userId: string, rule: string): Promise<boolean> => {
    const { data } = await supabase.from("user_activity_log")
      .select("id").eq("user_id", userId).eq("flag", `anomaly:${rule}`)
      .gte("created_at", new Date(now - 60 * MIN).toISOString()).limit(1);
    return !!(data && data.length);
  };
  const markAlerted = async (userId: string, rule: string) => {
    await supabase.from("user_activity_log").insert({
      user_id: userId, flag: `anomaly:${rule}`, path: `anomaly/${rule}`, method: "ALERT",
    });
  };

  try {
    // ── Regra 1: > 50 páginas distintas em 5 min ──────────────────────────────
    const { data: acts } = await supabase.from("user_activity_log")
      .select("user_id, path")
      .gte("created_at", new Date(now - 5 * MIN).toISOString())
      .not("user_id", "is", null)
      .limit(20000);
    const pathsByUser = new Map<string, Set<string>>();
    for (const a of (acts ?? []) as any[]) {
      if (!a.user_id || !a.path) continue;
      if (String(a.path).startsWith("anomaly/")) continue;
      if (!pathsByUser.has(a.user_id)) pathsByUser.set(a.user_id, new Set());
      pathsByUser.get(a.user_id)!.add(a.path);
    }
    for (const [userId, set] of pathsByUser) {
      if (set.size > 150 && !(await alertedRecently(userId, "burst_navigation"))) {
        await markAlerted(userId, "burst_navigation");
        await alertSuperAdmins(supabase, "⚠️ Navegação anômala (possível bot)",
          "Plataforma RENOV", `Usuário ${userId.slice(0, 8)} acessou ${set.size} páginas distintas em 5 min.`,
          "Verifique atividade — padrão de scraping.");
        alerted.push(`burst_navigation:${userId.slice(0, 8)}`);
      }
    }

    // ── Regra 2: > 5 PDFs em 10 min ───────────────────────────────────────────
    const { data: exps } = await supabase.from("export_log")
      .select("user_id, export_type")
      .gte("created_at", new Date(now - 10 * MIN).toISOString())
      .limit(20000);
    const pdfByUser = new Map<string, number>();
    for (const e of (exps ?? []) as any[]) {
      if (!e.user_id || String(e.export_type).toLowerCase() !== "pdf") continue;
      pdfByUser.set(e.user_id, (pdfByUser.get(e.user_id) ?? 0) + 1);
    }
    for (const [userId, n] of pdfByUser) {
      if (n > 15 && !(await alertedRecently(userId, "export_burst"))) {
        await markAlerted(userId, "export_burst");
        await alertSuperAdmins(supabase, "⚠️ Exportação em massa (possível bot)",
          "Plataforma RENOV", `Usuário ${userId.slice(0, 8)} exportou ${n} PDFs em 10 min.`,
          "Verifique — pode ser exfiltração automatizada.");
        alerted.push(`export_burst:${userId.slice(0, 8)}`);
      }
    }

    return jsonResp({ ok: true, alerted });
  } catch (e) {
    console.error("[security-anomaly-watchdog]", e instanceof Error ? e.message : String(e));
    return jsonResp({ ok: true, degraded: true });
  }
});
