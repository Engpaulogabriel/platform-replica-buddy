// useCommReliability — score de confiabilidade de comunicação por equipamento.
//
// "% de respostas nos últimos 7 dias" na prática = % do tempo em que o
// equipamento esteve ONLINE (comunicando) na janela. Fonte: os mesmos eventos
// equipamento_offline / equipamento_online do automation_log usados no Relatório
// de Comunicação. Equipamentos que ficam muito offline (ex.: POÇO 02 da Sykue)
// tendem a < 80% e ganham destaque no card + polling prioritário no agente.
//
// Retorna Map<equipment_name, score 0..100>. Chaveado por NOME porque é o que o
// automation_log guarda (equipment_name).
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

const WINDOW_DAYS = 7;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

export function useCommReliability(farmId: string | null): Map<string, number> {
  const [scores, setScores] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    if (!farmId) { setScores(new Map()); return; }
    let cancelled = false;
    void (async () => {
      const now = Date.now();
      const fromIso = new Date(now - WINDOW_MS).toISOString();
      const { data, error } = await supabase
        .from("automation_log")
        .select("equipment_name, occurred_at, details")
        .eq("farm_id", farmId)
        .gte("occurred_at", fromIso)
        .in("action", ["status_read"])
        .order("occurred_at", { ascending: true })
        .limit(4000);
      if (cancelled || error || !data) return;

      // Agrupa eventos offline/online por equipamento.
      const byEquip = new Map<string, Array<{ tipo: string; at: number }>>();
      for (const r of data as Array<any>) {
        const tipo = r.details?.tipo_evento;
        if (tipo !== "equipamento_offline" && tipo !== "equipamento_online") continue;
        const name = r.equipment_name;
        if (!name) continue;
        if (!byEquip.has(name)) byEquip.set(name, []);
        byEquip.get(name)!.push({ tipo, at: new Date(r.occurred_at).getTime() });
      }

      const windowStart = now - WINDOW_MS;
      const out = new Map<string, number>();
      for (const [name, evs] of byEquip) {
        // Soma o tempo OFFLINE dentro da janela pareando offline→online.
        let downtime = 0;
        let openOfflineAt: number | null = null;
        for (const ev of evs) {
          if (ev.tipo === "equipamento_offline") {
            if (openOfflineAt == null) openOfflineAt = ev.at;
          } else if (ev.tipo === "equipamento_online") {
            if (openOfflineAt != null) {
              downtime += Math.max(0, ev.at - openOfflineAt);
              openOfflineAt = null;
            }
          }
        }
        // Ainda offline agora: conta até o momento atual.
        if (openOfflineAt != null) downtime += Math.max(0, now - openOfflineAt);

        // Fração da janela (7 dias). Equipamentos sem evento de queda = 100%.
        const frac = Math.min(1, downtime / WINDOW_MS);
        const score = Math.round(Math.max(0, Math.min(100, (1 - frac) * 100)));
        void windowStart;
        out.set(name, score);
      }
      setScores(out);
    })();
    return () => { cancelled = true; };
  }, [farmId]);

  return scores;
}
