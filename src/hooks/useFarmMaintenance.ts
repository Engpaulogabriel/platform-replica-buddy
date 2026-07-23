// useFarmMaintenance — observa se a fazenda atual está em Modo Manutenção.
// Polling longo (120s) + canal Realtime próprio por fazenda.
// Retorna { active, expiresAt, secondsLeft, reason, activatedBy }.
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface FarmMaintenanceState {
  active: boolean;
  expiresAt: Date | null;
  secondsLeft: number;
  reason: string | null;
  activatedBy: string | null;
}

const EMPTY: FarmMaintenanceState = {
  active: false,
  expiresAt: null,
  secondsLeft: 0,
  reason: null,
  activatedBy: null,
};

export function useFarmMaintenance(farmId: string | null | undefined): FarmMaintenanceState {
  const [state, setState] = useState<FarmMaintenanceState>(EMPTY);

  useEffect(() => {
    if (!farmId) {
      setState(EMPTY);
      return;
    }
    let cancelled = false;

    const load = async () => {
      const { data } = await supabase
        .from("farm_maintenance_locks" as any)
        .select("expires_at, reason, activated_by")
        .eq("farm_id", farmId)
        .maybeSingle();
      if (cancelled) return;
      const row = data as any;
      if (!row) {
        setState(EMPTY);
        return;
      }
      const exp = new Date(row.expires_at);
      const sec = Math.max(0, Math.floor((exp.getTime() - Date.now()) / 1000));
      setState({
        active: sec > 0,
        expiresAt: exp,
        secondsLeft: sec,
        reason: row.reason ?? null,
        activatedBy: row.activated_by ?? null,
      });
    };

    void load();
    // EMERGÊNCIA: Realtime desabilitado globalmente (src/lib/realtimeKillSwitch.ts).
    // Polling HTTP simples a cada 15s mantém os dados atualizados.
    const poll = setInterval(() => { void load(); }, 15_000);
    const tick = setInterval(() => {
      setState((prev) => {
        if (!prev.active || !prev.expiresAt) return prev;
        const sec = Math.max(0, Math.floor((prev.expiresAt.getTime() - Date.now()) / 1000));
        if (sec === 0) return EMPTY;
        return { ...prev, secondsLeft: sec };
      });
    }, 1000);

    return () => {
      cancelled = true;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [farmId]);

  return state;
}

export function formatCountdown(sec: number): string {
  if (sec <= 0) return "0:00";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
