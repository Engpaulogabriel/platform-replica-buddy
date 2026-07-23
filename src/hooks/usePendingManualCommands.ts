// ─────────────────────────────────────────────────────────────────────────────
// usePendingManualCommands — mapa equipment_id → comando manual em andamento
// ─────────────────────────────────────────────────────────────────────────────
// Retorna todos os comandos type='manual' com status IN ('pending','sent')
// criados nos últimos 90s para a fazenda ativa. O front usa isso como
// FONTE DE VERDADE para mostrar "Ligando…/Desligando…" enquanto o Electron
// ainda faz reforço — evitando que RXs intermediárias (que escrevem
// last_confirmed_state=0 momentaneamente) façam o card piscar "Desligado".
//
// Polling curto (3s) enquanto houver algum comando ativo; 10s ocioso.

import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";

const PENDING_WINDOW_MS = 90_000;

export interface PendingManualCommand {
  id: string;
  equipmentId: string;
  createdAt: string; // ISO
  status: "pending" | "sent";
}

export function usePendingManualCommands(farmId: string | null | undefined): Map<string, PendingManualCommand> {
  const [map, setMap] = useState<Map<string, PendingManualCommand>>(new Map());
  const activeRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!farmId) {
      setMap((prev) => (prev.size === 0 ? prev : new Map()));
      activeRef.current = false;
      return;
    }
    const since = new Date(Date.now() - PENDING_WINDOW_MS).toISOString();
    const { data, error } = await supabase
      .from("commands")
      .select("id,equipment_id,created_at,status")
      .eq("farm_id", farmId)
      .eq("type", "manual")
      .in("status", ["pending", "sent"])
      .gte("created_at", since);
    if (error) {
      console.warn("[usePendingManualCommands]", error.message);
      return;
    }
    const next = new Map<string, PendingManualCommand>();
    for (const row of (data ?? []) as Array<{
      id: string;
      equipment_id: string;
      created_at: string;
      status: "pending" | "sent";
    }>) {
      // Se houver mais de um comando manual para o mesmo eq, mantém o mais novo.
      const cur = next.get(row.equipment_id);
      if (!cur || new Date(row.created_at).getTime() > new Date(cur.createdAt).getTime()) {
        next.set(row.equipment_id, {
          id: row.id,
          equipmentId: row.equipment_id,
          createdAt: row.created_at,
          status: row.status,
        });
      }
    }
    activeRef.current = next.size > 0;
    setMap((prev) => {
      if (prev.size !== next.size) return next;
      for (const [k, v] of next) {
        const p = prev.get(k);
        if (!p || p.id !== v.id || p.status !== v.status) return next;
      }
      return prev;
    });
  }, [farmId]);

  useEffect(() => {
    if (!farmId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const loop = async () => {
      if (cancelled) return;
      await refresh();
      if (cancelled) return;
      const delay = activeRef.current ? 3_000 : 10_000;
      timer = setTimeout(loop, delay);
    };
    void loop();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [farmId, refresh]);

  return map;
}
