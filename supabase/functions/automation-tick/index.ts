// Edge Function: automation-tick
// Roda a cada minuto via pg_cron. Exige header `Authorization: Bearer <CRON_SECRET>`
// onde CRON_SECRET == SUPABASE_SERVICE_ROLE_KEY (o pg_cron tem acesso via vault).
// Isso impede que terceiros invoquem a função publicamente.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-cron-secret",
};

// Comparação de strings em tempo constante (evita timing attacks)
function safeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // ── Auth ────────────────────────────────────────────────────────────────
  // Aceita, nesta ordem: `x-cron-secret` (como `cron_invoke()` envia) ou
  // `Authorization: Bearer <segredo>`, casando com CRON_SECRET **ou** com o
  // rotacionado CRON_SECRET_V2; e bearer com a service_role key.
  //
  // POR QUE V2: `cron_invoke()` lê o segredo do Vault. Quando ele foi
  // rotacionado, o Vault passou a mandar o valor novo enquanto esta função só
  // comparava com CRON_SECRET — 401 a cada minuto. Durante a janela de rotação
  // os DOIS valores são válidos; nenhum aparece aqui, só o nome do env.
  //
  // O QUE SAIU: a validação `isValidProjectJwt`, que aceitava QUALQUER JWT do
  // projeto — inclusive a anon key, que é pública e vai no bundle do frontend.
  // Isso é bypass anônimo. Além disso o `projectRef` estava fixado em
  // "vabguxllyguztneumahq", que não é o projeto real (`dnyukgfedredvxpzjpqz`),
  // então a comparação nunca casava: era um bypass quebrado — inseguro por
  // intenção e não-funcional na prática. Removido, não consertado.
  const cronSecret   = (Deno.env.get("CRON_SECRET") ?? "").trim();
  const cronSecretV2 = (Deno.env.get("CRON_SECRET_V2") ?? "").trim();
  const serviceRole  = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();

  const presented = (req.headers.get("x-cron-secret") ?? "").trim();
  const authHeader = (req.headers.get("Authorization") ?? "").trim();
  const bearer = /^bearer\s+/i.test(authHeader)
    ? authHeader.replace(/^bearer\s+/i, "").trim()
    : "";

  // Só segredos realmente configurados viram candidatos: um env vazio jamais
  // pode casar com uma requisição sem credencial.
  const secrets = [cronSecret, cronSecretV2].filter((s) => s.length > 0);
  const isAuthorized =
    (presented.length > 0 && secrets.some((s) => safeEquals(presented, s))) ||
    (bearer.length > 0 && secrets.some((s) => safeEquals(bearer, s))) ||
    (bearer.length > 0 && serviceRole.length > 0 && safeEquals(bearer, serviceRole));

  if (!isAuthorized) {
    return new Response(JSON.stringify({ ok: false, error: "unauthorized" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data, error } = await supabase.rpc("run_automation_tick");
    // RETURNS TABLE(enqueued_count, schedules_evaluated) chega como ARRAY de
    // linhas. Ler `data.enqueued_count` direto dá undefined e o log da tick
    // mostrava "0 enfileirados" mesmo quando havia comando criado.
    const tick = Array.isArray(data) ? data[0] : data;
    if (error) {
      console.error("[automation-tick] RPC error:", error);
      return new Response(
        JSON.stringify({ ok: false, error: error.message }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    const { data: purgeData, error: purgeErr } = await supabase.rpc(
      "purge_stale_on_commands_when_bridge_down",
    );
    if (purgeErr) {
      console.error("[automation-tick] purge error:", purgeErr);
    } else if (Array.isArray(purgeData) && purgeData.length > 0) {
      const totalCancelled = purgeData.reduce(
        (s: number, r: { cancelled_count: number }) => s + (r.cancelled_count ?? 0),
        0,
      );
      console.log(
        `[automation-tick] safety-purge: cancelled ${totalCancelled} ON-commands across ${purgeData.length} offline farm(s)`,
      );
    }

    // REMOVIDO: purge_on_commands_for_offline_pumps
    // Esta função zerava desired_running automaticamente, violando a regra
    // absoluta de que esse campo só pode ser alterado por ação humana ou
    // automação configurada pelo usuário. Função DROPada na migração de 2026-05-26.

    const { data: protectiveOff, error: protErr } = await supabase.rpc(
      "enqueue_protective_off_for_offline_pumps",
    );
    if (protErr) {
      console.error("[automation-tick] protective-off error:", protErr);
    } else if (Array.isArray(protectiveOff) && protectiveOff.length > 0) {
      console.log(
        `[automation-tick] protective-off: ${protectiveOff.length} TX OFF enfileirado(s) para bombas offline com estado=ON`,
      );
    }

    // Indicador de Balanço Hídrico — gera alertas (insuficiente, sem captação, crítico)
    const { data: wbAlerts, error: wbErr } = await supabase.rpc(
      "check_water_balance_alerts",
    );
    if (wbErr) {
      console.error("[automation-tick] water-balance error:", wbErr);
    } else if (wbAlerts && (wbAlerts as { inserted?: number }).inserted) {
      console.log(
        `[automation-tick] water-balance: ${(wbAlerts as { inserted: number }).inserted} alerta(s) inserido(s)`,
      );
    }

    // Eficiência energética — gera alertas (17:55, 21:05, 21:15) e fecha o dia (21:10, 23:55)
    const { data: effAlerts, error: effErr } = await supabase.rpc(
      "check_peak_efficiency_alerts",
    );
    if (effErr) {
      console.error("[automation-tick] energy-efficiency error:", effErr);
    } else if (typeof effAlerts === "number" && effAlerts > 0) {
      console.log(`[automation-tick] energy-efficiency: ${effAlerts} alerta(s) inserido(s)`);
    }

    const { data: failedAuto, error: failedAutoErr } = await supabase.rpc(
      "mark_automation_command_failures",
    );
    if (failedAutoErr) {
      console.error("[automation-tick] mark-failures error:", failedAutoErr);
    } else if (typeof failedAuto === "number" && failedAuto > 0) {
      console.log(
        `[automation-tick] mark-failures: ${failedAuto} comando(s) automático(s) sem resposta registrado(s) como falha.`,
      );
    }

    // Peak-hour automation (turn pumps off at start_time / back on at end_time)
    const { data: peakData, error: peakErr } = await supabase.rpc("run_peak_hour_tick");
    if (peakErr) {
      console.error("[automation-tick] peak-hour error:", peakErr);
    } else if (Array.isArray(peakData) && peakData.length > 0) {
      const row = peakData[0] as { off_enqueued?: number; on_enqueued?: number };
      if ((row.off_enqueued ?? 0) > 0 || (row.on_enqueued ?? 0) > 0) {
        console.log(`[automation-tick] peak-hour: off=${row.off_enqueued ?? 0} on=${row.on_enqueued ?? 0}`);
      }
    }

    // Automações independentes (Fase 2)
    const { data: autoData, error: autoErr } = await supabase.rpc("run_automacoes_tick");
    if (autoErr) {
      console.error("[automation-tick] automacoes error:", autoErr);
    } else if (Array.isArray(autoData) && autoData.length > 0) {
      const row = autoData[0] as { fired?: number; actions_enqueued?: number };
      if ((row.fired ?? 0) > 0) {
        console.log(`[automation-tick] automacoes: fired=${row.fired} actions=${row.actions_enqueued}`);
      }
    }



    const result = tick as { enqueued_count?: number; schedules_evaluated?: number } | null;
    console.log(
      `[automation-tick] enqueued=${result?.enqueued_count ?? 0} evaluated=${result?.schedules_evaluated ?? 0}`,
    );

    return new Response(
      JSON.stringify({
        ok: true,
        ...result,
        safety_purged: Array.isArray(purgeData) ? purgeData : [],
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[automation-tick] fatal:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
