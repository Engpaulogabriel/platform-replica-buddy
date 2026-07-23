import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Para cada reservatório, busca os últimos ~30 min de `level_history`
 * e calcula em quantos minutos vai esvaziar com base na taxa de
 * variação (% por minuto). Só retorna ETA para reservatórios que
 * estão DRENANDO (slope negativo). Atualiza a cada 60s.
 */
export function useReservoirDrainEta(
  equipmentIds: string[],
): Record<string, { minutesToEmpty: number; ratePctPerMin: number } | null> {
  const [eta, setEta] = useState<
    Record<string, { minutesToEmpty: number; ratePctPerMin: number } | null>
  >({});

  // Estável p/ deps
  const key = equipmentIds.slice().sort().join(",");

  useEffect(() => {
    if (!key) {
      setEta({});
      return;
    }
    const ids = key.split(",").filter(Boolean);
    let cancelled = false;

    const fetchAll = async () => {
      // Janela ampla (6h) — telemetria pode ter poucas amostras por hora.
      const since = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
      const { data, error } = await supabase
        .from("level_history")
        .select("equipment_id, read_at, percent")
        .in("equipment_id", ids)
        .gte("read_at", since)
        .order("read_at", { ascending: true })
        .limit(5000);

      if (cancelled || error || !data) return;

      const byEq = new Map<
        string,
        Array<{ t: number; p: number }>
      >();
      for (const row of data as Array<{
        equipment_id: string;
        read_at: string;
        percent: number | null;
      }>) {
        if (row.percent == null) continue;
        const arr = byEq.get(row.equipment_id) ?? [];
        arr.push({
          t: new Date(row.read_at).getTime(),
          p: Number(row.percent),
        });
        byEq.set(row.equipment_id, arr);
      }

      const next: Record<
        string,
        { minutesToEmpty: number; ratePctPerMin: number } | null
      > = {};

      ids.forEach((id) => {
        const pts = byEq.get(id);
        if (!pts || pts.length < 2) {
          next[id] = null;
          return;
        }
        // Regressão linear simples
        const n = pts.length;
        const sumX = pts.reduce((s, p) => s + p.t, 0);
        const sumY = pts.reduce((s, p) => s + p.p, 0);
        const sumXY = pts.reduce((s, p) => s + p.t * p.p, 0);
        const sumXX = pts.reduce((s, p) => s + p.t * p.t, 0);
        const denom = n * sumXX - sumX * sumX;
        if (denom === 0) {
          next[id] = null;
          return;
        }
        const slopePerMs = (n * sumXY - sumX * sumY) / denom; // %/ms
        const ratePctPerMin = slopePerMs * 60_000;

        const last = pts[pts.length - 1];
        // Só projeta esvaziamento se há tendência real de queda.
        if (ratePctPerMin >= -0.005) {
          next[id] = null;
          return;
        }
        const minutesToEmpty = last.p / -ratePctPerMin;
        if (!isFinite(minutesToEmpty) || minutesToEmpty <= 0) {
          next[id] = null;
          return;
        }
        next[id] = { minutesToEmpty, ratePctPerMin };
      });

      setEta(next);
    };

    fetchAll();
    const iv = window.setInterval(fetchAll, 300_000); // 5 min — ETA de esvaziamento muda devagar
    return () => {
      cancelled = true;
      window.clearInterval(iv);
    };
  }, [key]);

  return eta;
}

export function formatEta(minutes: number): string {
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes - h * 60);
  if (h < 24) return m > 0 ? `${h}h ${m}min` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h - d * 24;
  return rh > 0 ? `${d}d ${rh}h` : `${d}d`;
}
