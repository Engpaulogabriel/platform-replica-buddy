// Verifies WhatsApp-issued LIGAR/DESLIGAR commands after 90s.
// If equipment state does NOT match expected, sends a short failure alert
// to the operator who issued the command.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

function readOutputBit(outs: string | null | undefined, saida: number | null | undefined): boolean | null {
  const o = String(outs ?? "");
  const sIdx = Math.max(1, Math.min(6, saida ?? 1));
  if (/^[01]{6}$/.test(o)) return o.charAt(sIdx - 1) === "1";
  if (/^[01]$/.test(o)) return o === "1";
  return null;
}

async function getWhatsAppCreds(farmId: string | null): Promise<{ token: string; phoneId: string } | null> {
  const q = supabase.from("whatsapp_config").select("api_token, phone_number_id, farm_id").limit(1);
  let { data } = farmId
    ? await supabase.from("whatsapp_config").select("api_token, phone_number_id").eq("farm_id", farmId).maybeSingle()
    : { data: null as any };
  if (!data) {
    const { data: any1 } = await q.maybeSingle();
    data = any1;
  }
  if (!data?.api_token || !data?.phone_number_id) return null;
  return { token: data.api_token, phoneId: data.phone_number_id };
}

async function sendWhatsAppText(phone: string, body: string, farmId: string | null) {
  const creds = await getWhatsAppCreds(farmId);
  if (!creds) {
    console.error("command-verifier: no WhatsApp creds available");
    return;
  }
  const url = `https://graph.facebook.com/v21.0/${creds.phoneId}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: phone,
      type: "text",
      text: { body },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("command-verifier: WhatsApp send failed", res.status, t);
  } else {
    try {
      await supabase.from("whatsapp_message_log").insert({
        direction: "outgoing",
        phone,
        farm_id: farmId,
        message_type: "text",
        message_body: body,
        metadata: { source: "command-verifier" },
      });
    } catch (_) { /* ignore */ }
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // Multi-attempt verification window to avoid false positives from slow
    // hardware polling. We start CHECKING at 30s after the command, but only
    // raise the "Erro local" alert if the equipment still does not match the
    // expected state after FINAL_TIMEOUT_MS (3 minutes). On every tick in
    // between, if the state matches we mark success early — no alert.
    const SOFT_CHECK_MS = 30_000;     // start polling here
    const FINAL_TIMEOUT_MS = 180_000; // only alert after this window

    const softCutoff = new Date(Date.now() - SOFT_CHECK_MS).toISOString();
    const finalCutoff = Date.now() - FINAL_TIMEOUT_MS;

    const { data: pending, error } = await supabase
      .from("command_verifications")
      .select("id, equipment_id, equipment_name, expected_state, operator_phone, farm_id, command_sent_at")
      .is("verified_at", null)
      .lte("command_sent_at", softCutoff)
      .limit(100);
    if (error) throw error;

    let checked = 0, failed = 0, success = 0, deferred = 0;

    for (const v of (pending ?? []) as any[]) {
      checked++;
      const { data: eq } = await supabase
        .from("equipments")
        .select("id, name, desired_running, communication_status, last_outputs_state, saida")
        .eq("id", v.equipment_id)
        .maybeSingle();

      const expectedOn = v.expected_state === "on";
      const physical = readOutputBit((eq as any)?.last_outputs_state, (eq as any)?.saida);
      const desired = (eq as any)?.desired_running;
      const matches =
        (physical !== null && physical === expectedOn) ||
        (physical === null && typeof desired === "boolean" && desired === expectedOn);

      // Success at any check → mark and skip alert.
      if (matches) {
        await supabase
          .from("command_verifications")
          .update({ verified_at: new Date().toISOString(), result: "success" })
          .eq("id", v.id);
        success++;
        continue;
      }

      // Not matching yet — only alert after the final window. Otherwise leave
      // the row pending so the next tick re-checks (hardware polling may not
      // have updated last_outputs_state yet).
      const sentAtMs = new Date(v.command_sent_at).getTime();
      if (sentAtMs > finalCutoff) {
        deferred++;
        continue;
      }

      await supabase
        .from("command_verifications")
        .update({ verified_at: new Date().toISOString(), result: "failed" })
        .eq("id", v.id);
      failed++;

      const name = v.equipment_name || (eq as any)?.name || "Equipamento";
      const msg = `⚠️ ${name} — não consegui confirmar que o comando foi executado. Verifique localmente.`;

      if (v.operator_phone) {
        await sendWhatsAppText(v.operator_phone, msg, v.farm_id);
      }

      try {
        await supabase.from("whatsapp_audit_log").insert({
          event_type: "command_verification_failed",
          farm_id: v.farm_id,
          actor_phone: v.operator_phone,
          target_name: name,
          details: {
            equipment_id: v.equipment_id,
            equipment_name: name,
            expected_state: v.expected_state,
            command_sent_at: v.command_sent_at,
            physical_state: physical,
            desired_running: desired,
            window_ms: FINAL_TIMEOUT_MS,
          },
        });
      } catch (e) {
        console.error("command-verifier: audit log insert failed", e);
      }
    }

    return new Response(
      JSON.stringify({ ok: true, checked, success, failed, deferred }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (e) {
    console.error("command-verifier error", e);
    return new Response(
      JSON.stringify({ ok: false, error: String((e as Error)?.message ?? e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
