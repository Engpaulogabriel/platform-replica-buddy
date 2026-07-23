// useEquipmentMaintenance — fonte única de dados de manutenção de
// equipamentos por fazenda. Polling 30s. Expõe ações para bloquear/liberar.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { useAuth } from "@/contexts/AuthContext";
import { enqueueManualPumpCommand } from "@/lib/commandQueue";

export interface EquipMaintRow {
  id: string;
  name: string;
  type: string;
  active: boolean;
  desired_running: boolean | null;
  last_outputs_state: string | null;
  saida: number | null;
  maintenance_mode: boolean;
  maintenance_reason: string | null;
  maintenance_started_at: string | null;
  maintenance_started_by: string | null;
  maintenance_started_via: string | null;
  communication_status: string | null;
}

const SELECT_COLS =
  "id,name,type,active,desired_running,last_outputs_state,saida,communication_status," +
  "maintenance_mode,maintenance_reason,maintenance_started_at,maintenance_started_by,maintenance_started_via";

export function useEquipmentMaintenance() {
  const farmId = useDefaultFarmId();
  const { user } = useAuth();
  const [rows, setRows] = useState<EquipMaintRow[]>([]);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!farmId) return;
    setLoading(true);
    const { data } = await supabase
      .from("equipments")
      .select(SELECT_COLS)
      .eq("farm_id", farmId)
      .eq("active", true)
      .neq("type", "nivel")
      .neq("type", "repetidor")
      .order("name");
    setRows(((data ?? []) as unknown) as EquipMaintRow[]);
    setLoading(false);
  }, [farmId]);

  useEffect(() => {
    void reload();
    const id = setInterval(() => void reload(), 30_000);
    return () => clearInterval(id);
  }, [reload]);

  const userLabel = (user?.user_metadata?.full_name as string | undefined)
    || user?.email
    || "Operador";

  const activate = useCallback(
    async (equipmentId: string, reason: string | null, shutdownNow: boolean) => {
      if (!farmId) throw new Error("Fazenda não definida");

      // 1) Marca manutenção primeiro — qualquer comando ON em paralelo será rejeitado pelo trigger.
      const { error: upErr } = await supabase
        .from("equipments")
        .update({
          maintenance_mode: true,
          maintenance_reason: reason && reason.trim() ? reason.trim() : null,
          maintenance_started_at: new Date().toISOString(),
          maintenance_started_by: userLabel,
          maintenance_started_via: "frontend",
        })
        .eq("id", equipmentId)
        .eq("farm_id", farmId);
      if (upErr) throw new Error(upErr.message);

      // 2) Se solicitado, envia desligamento agora (desired_running=false é permitido).
      if (shutdownNow) {
        try {
          await enqueueManualPumpCommand({ equipmentId, turnOn: false, userId: user?.id ?? null, userName: userLabel });
        } catch (err) {
          // Não falha a operação inteira — bloqueio já está ativo.
          console.warn("[manutencao] falha ao enviar desligamento:", err);
        }
      }

      await reload();
    },
    [farmId, reload, user?.id, userLabel],
  );

  const release = useCallback(
    async (equipmentId: string) => {
      if (!farmId) throw new Error("Fazenda não definida");
      const { error } = await supabase
        .from("equipments")
        .update({
          maintenance_mode: false,
          maintenance_reason: null,
          maintenance_started_at: null,
          maintenance_started_by: null,
          maintenance_started_via: null,
        })
        .eq("id", equipmentId)
        .eq("farm_id", farmId);
      if (error) throw new Error(error.message);
      await reload();
    },
    [farmId, reload],
  );

  return { rows, loading, reload, activate, release, farmId };
}

/** Helper para formatar duração desde um ISO timestamp. */
export function formatMaintenanceDuration(startedAt: string | null | undefined): string {
  if (!startedAt) return "—";
  const start = new Date(startedAt).getTime();
  if (!Number.isFinite(start)) return "—";
  const diffMs = Math.max(0, Date.now() - start);
  const min = Math.floor(diffMs / 60_000);
  if (min < 1) return "<1min";
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? `${h}h ${m}min` : `${h}h`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return hh ? `${d}d ${hh}h` : `${d}d`;
}

export function formatMaintenanceStartedAt(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  }).replace(",", "");
}
