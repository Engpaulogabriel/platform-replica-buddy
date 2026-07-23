// v3.14.1 — Cleanup do bucket privado `agent-logs`.
// Regras por fazenda: (1) apagar arquivos com > 30 dias; (2) enquanto o total
// da pasta passar de 200 MB, apagar os mais antigos.
// Roda via pg_cron a cada 6h.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RETENTION_DAYS = 30;
const CAP_BYTES_PER_FARM = 200 * 1024 * 1024;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const url = Deno.env.get("SUPABASE_URL")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(url, service, { auth: { persistSession: false } });

  const summary: Record<string, { deleted_old: number; deleted_cap: number; kept: number; bytes: number }> = {};
  try {
    // Lista pastas raiz (uma por farm_id)
    const { data: farms, error: fErr } = await sb.storage.from("agent-logs").list("", { limit: 1000 });
    if (fErr) throw fErr;

    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

    for (const folder of farms ?? []) {
      if (!folder.name || folder.id) continue; // sub-arquivo raiz — ignorar
      const farmId = folder.name;
      const { data: files } = await sb.storage.from("agent-logs").list(farmId, { limit: 1000, sortBy: { column: "name", order: "asc" } });
      if (!files) continue;

      const toDeleteOld: string[] = [];
      const alive: { path: string; size: number; created: number }[] = [];
      for (const f of files) {
        if (!f.name || !f.name.endsWith(".rlog")) continue;
        const created = new Date(f.created_at ?? f.updated_at ?? Date.now()).getTime();
        const size = (f.metadata as any)?.size ?? 0;
        if (created < cutoff) {
          toDeleteOld.push(`${farmId}/${f.name}`);
        } else {
          alive.push({ path: `${farmId}/${f.name}`, size, created });
        }
      }
      if (toDeleteOld.length > 0) await sb.storage.from("agent-logs").remove(toDeleteOld);

      // Cap por fazenda — remove mais antigos até caber
      alive.sort((a, b) => a.created - b.created);
      let total = alive.reduce((s, x) => s + x.size, 0);
      const toDeleteCap: string[] = [];
      while (total > CAP_BYTES_PER_FARM && alive.length > 1) {
        const drop = alive.shift()!;
        toDeleteCap.push(drop.path);
        total -= drop.size;
      }
      if (toDeleteCap.length > 0) await sb.storage.from("agent-logs").remove(toDeleteCap);

      summary[farmId] = {
        deleted_old: toDeleteOld.length,
        deleted_cap: toDeleteCap.length,
        kept: alive.length,
        bytes: total,
      };
    }

    return new Response(JSON.stringify({ ok: true, summary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String((e as Error).message ?? e), summary }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
