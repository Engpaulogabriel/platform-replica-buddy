// ─────────────────────────────────────────────────────────────────────────────
// useCloudAutomation — fonte única (nuvem) das programações, configs de
// feriado e flag do motor. Substitui as leituras/escritas em localStorage.
// ─────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { useAuth } from "@/contexts/AuthContext";
import { notifyWhatsAppImmediate, type WhatsAppNotifyDiagnosticResult } from "@/lib/whatsappNotify";


export type ScheduleMode = "on-only" | "off-only";

export interface CloudSchedule {
  id: string; // uuid da nuvem
  farmId: string;
  equipmentId: string;
  active: boolean;
  mode: ScheduleMode;
  days: string[];
  timeOn: string;
  timeOff: string;
}

export interface CloudHolidayConfig {
  enabled: boolean;
  mode: "free-demand" | "special-schedule";
  specialTimeOn: string;
  specialTimeOff: string;
}

interface UseCloudAutomationResult {
  loading: boolean;
  engineActive: boolean;
  schedules: CloudSchedule[];
  holidayConfigs: Record<string, CloudHolidayConfig>;
  setEngineActive: (active: boolean) => Promise<WhatsAppNotifyDiagnosticResult | void>;
  createSchedule: (input: Omit<CloudSchedule, "id" | "farmId">) => Promise<void>;
  updateSchedule: (id: string, patch: Partial<Omit<CloudSchedule, "id" | "farmId">>) => Promise<void>;
  deleteSchedule: (id: string) => Promise<void>;
  toggleSchedule: (id: string) => Promise<void>;
  upsertHoliday: (equipmentId: string, patch: Partial<CloudHolidayConfig>) => Promise<void>;
  refresh: () => Promise<void>;
}

const AUTOMATION_UPDATED_EVENT = "automation:updated";

function emitAutomationUpdated() {
  try {
    window.dispatchEvent(new Event(AUTOMATION_UPDATED_EVENT));
  } catch {
    /* ignore */
  }
}

async function invokeAutomationNotify(body: Record<string, unknown>) {
  const { type, ...rest } = body as { type?: string } & Record<string, unknown>;
  console.log("[MODE_CHANGE] invokeAutomationNotify payload:", { type: type ?? "mode_change", ...rest });
  return notifyWhatsAppImmediate(
    (type as Parameters<typeof notifyWhatsAppImmediate>[0]) ?? "mode_change",
    rest,
  );
}

export function useCloudAutomation(): UseCloudAutomationResult {
  const farmId = useDefaultFarmId();
  const { user } = useAuth();
  const metadataName = String(user?.user_metadata?.name ?? user?.user_metadata?.full_name ?? "").trim();
  const [performerName, setPerformerName] = useState<string>(metadataName || user?.email || "Usuário Web");
  const [loading, setLoading] = useState(true);
  const [engineActive, setEngineActiveState] = useState(true);
  const [schedules, setSchedules] = useState<CloudSchedule[]>([]);
  const [holidayConfigs, setHolidayConfigs] = useState<Record<string, CloudHolidayConfig>>({});
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);


  useEffect(() => {
    const fallbackName = metadataName || user?.email || "Usuário Web";
    if (!user?.id) {
      setPerformerName("Usuário Web");
      return;
    }

    let cancelled = false;
    setPerformerName(fallbackName);
    supabase
      .from("profiles")
      .select("full_name, email")
      .eq("id", user.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.warn("[useCloudAutomation] profile lookup failed", error.message);
          setPerformerName(fallbackName);
          return;
        }
        const profileName = String(data?.full_name ?? "").trim();
        const profileEmail = String(data?.email ?? "").trim();
        setPerformerName(profileName || fallbackName || profileEmail || "Usuário Web");
      });

    return () => { cancelled = true; };
  }, [user?.id, user?.email, metadataName]);


  const refresh = useCallback(async () => {
    if (!farmId) {
      setSchedules([]);
      setHolidayConfigs({});
      setEngineActiveState(true);
      setLoading(false);
      return;
    }

    setLoading(true);
    const [schRes, holRes, engRes] = await Promise.all([
      supabase
        .from("automation_schedules")
        .select("id, farm_id, equipment_id, active, mode, days, time_on, time_off")
        .eq("farm_id", farmId),
      supabase
        .from("automation_holiday_configs")
        .select("equipment_id, enabled, mode, special_time_on, special_time_off")
        .eq("farm_id", farmId),
      supabase
        .from("automation_engine")
        .select("enabled")
        .eq("farm_id", farmId)
        .maybeSingle(),
    ]);

    if (!schRes.error && schRes.data) {
      setSchedules(
        schRes.data.map((r) => ({
          id: r.id,
          farmId: r.farm_id,
          equipmentId: r.equipment_id,
          active: r.active,
          mode: r.mode as ScheduleMode,
          days: r.days ?? [],
          timeOn: r.time_on,
          timeOff: r.time_off,
        })),
      );
    }

    if (!holRes.error && holRes.data) {
      const map: Record<string, CloudHolidayConfig> = {};
      for (const r of holRes.data) {
        map[r.equipment_id] = {
          enabled: r.enabled,
          mode: r.mode as "free-demand" | "special-schedule",
          specialTimeOn: r.special_time_on,
          specialTimeOff: r.special_time_off,
        };
      }
      setHolidayConfigs(map);
    }

    if (!engRes.error) {
      setEngineActiveState(engRes.data?.enabled ?? true);
    }

    setLoading(false);
  }, [farmId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onUpdated = () => {
      void refresh();
    };

    window.addEventListener(AUTOMATION_UPDATED_EVENT, onUpdated);
    return () => window.removeEventListener(AUTOMATION_UPDATED_EVENT, onUpdated);
  }, [refresh]);

  // Polling leve do estado do motor — captura toggles feitos fora do frontend
  // (WhatsApp, automações server-side) já que Realtime está desabilitado
  // globalmente. Query mínima (só a coluna `enabled`); se mudou vs estado
  // local, dispara refresh completo para trazer schedules/feriados junto.
  useEffect(() => {
    if (!farmId) return;
    let cancelled = false;
    const tick = async () => {
      const { data, error } = await supabase
        .from("automation_engine")
        .select("enabled")
        .eq("farm_id", farmId)
        .maybeSingle();
      if (cancelled || error) return;
      const remote = data?.enabled ?? true;
      setEngineActiveState((prev) => {
        if (prev !== remote) {
          // Fora do render: refetch completo para sincronizar schedules também.
          queueMicrotask(() => { void refresh(); });
        }
        return remote;
      });
    };
    const id = window.setInterval(() => { void tick(); }, 10000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [farmId, refresh]);


  // Realtime: refaz fetch quando outra sessão alterar
  useEffect(() => {
    if (!farmId) return;

    const previousChannel = channelRef.current;
    if (previousChannel) {
      try {
        void supabase.removeChannel(previousChannel);
      } catch {
        /* ignore */
      }
      channelRef.current = null;
    }

    const channelName = `automation-${farmId}-${Math.random().toString(36).slice(2, 8)}`;
    const channel = supabase.channel(channelName);

    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "automation_schedules", filter: `farm_id=eq.${farmId}` },
      () => { void refresh(); },
    );
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "automation_holiday_configs", filter: `farm_id=eq.${farmId}` },
      () => { void refresh(); },
    );
    channel.on(
      "postgres_changes",
      { event: "*", schema: "public", table: "automation_engine", filter: `farm_id=eq.${farmId}` },
      () => { void refresh(); },
    );
    channel.subscribe();

    channelRef.current = channel;

    return () => {
      if (channelRef.current === channel) {
        try {
          void supabase.removeChannel(channel);
        } catch {
          /* ignore */
        }
        channelRef.current = null;
      }
    };
  }, [farmId, refresh]);

  const setEngineActive = useCallback(async (active: boolean) => {
    if (!farmId) throw new Error("Fazenda não identificada — não foi possível alterar o modo automático.");
    console.log("[MODE_CHANGE] Toggle clicked. Equipment:", "automation_engine", "New state:", active);
    console.log("[MODE_CHANGE] Updating automation_engine:", { farmId, active, performerName });

    // BUGFIX: NÃO faça optimistic update aqui. Antes, fazíamos
    // setEngineActiveState(active) + emitAutomationUpdated() ANTES do await,
    // o que disparava refresh() que lia o valor antigo do DB (upsert ainda
    // não havia completado) e revertia o estado local para false. Resultado:
    // o primeiro clique mostrava "Ativado" mas o switch voltava para off.
    // Agora aguardamos a confirmação do upsert antes de atualizar a UI.
    const { error } = await supabase
      .from("automation_engine")
      .upsert(
        { farm_id: farmId, enabled: active, last_changed_by: performerName, last_changed_via: "frontend" },
        { onConflict: "farm_id" },
      );


    if (error) {
      console.error("[MODE_CHANGE] automation_engine update failed:", error);
      throw new Error(error.message);
    }
    console.log("[MODE_CHANGE] automation_engine updated. Calling WhatsApp notification.", { farmId, active });

    const notifyResult = await invokeAutomationNotify({
      type: "mode_change",
      farm_id: farmId,
      new_mode: active ? "on" : "off",
      changed_by: performerName,
      source: "frontend",
    });
    console.log("[MODE_CHANGE] WhatsApp notification call completed for automation_engine:", { farmId, active });

    setEngineActiveState(active);
    emitAutomationUpdated();
    return notifyResult;
  }, [farmId, performerName]);


  const createSchedule = useCallback(async (input: Omit<CloudSchedule, "id" | "farmId">) => {
    if (!farmId) throw new Error("Fazenda não identificada");

    const insertBody = {
      farm_id: farmId,
      equipment_id: input.equipmentId,
      active: input.active,
      mode: input.mode,
      days: input.days,
      time_on: input.timeOn,
      time_off: input.timeOff,
      created_by_name: performerName,
      created_by_via: "frontend",
      last_modified_by_name: performerName,
      last_modified_by_via: "frontend",
      last_toggled_by: performerName,
      last_toggled_via: "frontend",
    };


    console.log("[useCloudAutomation] createSchedule insert", insertBody);

    const { data, error } = await supabase
      .from("automation_schedules")
      .insert(insertBody)
      .select("id")
      .single();

    if (error) {
      console.error("[useCloudAutomation] createSchedule error", error);
      const detail = [error.message, error.details, error.hint].filter(Boolean).join(" — ");
      throw new Error(detail || "Falha ao criar programação");
    }

    console.log("[useCloudAutomation] createSchedule ok", data);

    if (input.active) {
      console.log("[MODE_CHANGE] Toggle clicked. Equipment:", input.equipmentId, "New state:", true);
      await invokeAutomationNotify({
        type: "mode_change",
        farm_id: farmId,
        equipment_id: input.equipmentId,
        new_mode: "on",
        changed_by: performerName,
        source: "frontend",
      });
    }

    emitAutomationUpdated();
    await refresh();
  }, [farmId, performerName, refresh]);

  const updateSchedule = useCallback(async (id: string, patch: Partial<Omit<CloudSchedule, "id" | "farmId">>) => {
    const updateBody: {
      active?: boolean;
      mode?: ScheduleMode;
      days?: string[];
      time_on?: string;
      time_off?: string;
      equipment_id?: string;
      last_modified_by_name?: string;
      last_modified_by_via?: string;
      last_toggled_by?: string;
      last_toggled_via?: string;
    } = {
      last_modified_by_name: performerName,
      last_modified_by_via: "frontend",
    };

    if (patch.active !== undefined) {
      updateBody.active = patch.active;
      updateBody.last_toggled_by = performerName;
      updateBody.last_toggled_via = "frontend";
    }

    if (patch.mode !== undefined) updateBody.mode = patch.mode;
    if (patch.days !== undefined) updateBody.days = patch.days;
    if (patch.timeOn !== undefined) updateBody.time_on = patch.timeOn;
    if (patch.timeOff !== undefined) updateBody.time_off = patch.timeOff;
    if (patch.equipmentId !== undefined) updateBody.equipment_id = patch.equipmentId;

    const { error } = await supabase.from("automation_schedules").update(updateBody).eq("id", id);
    if (error) throw new Error(error.message);

    if (patch.active !== undefined) {
      const equipmentId = patch.equipmentId ?? schedules.find((s) => s.id === id)?.equipmentId;
      console.log("[MODE_CHANGE] Toggle clicked. Equipment:", equipmentId, "New state:", patch.active);
      console.log("[MODE_CHANGE] Schedule mode changed. Calling WhatsApp notification:", { scheduleId: id, farmId, equipmentId, active: patch.active, performerName });
      await invokeAutomationNotify({
        type: "mode_change",
        farm_id: farmId,
        equipment_id: equipmentId,
        new_mode: patch.active ? "on" : "off",
        changed_by: performerName,
        source: "frontend",
      });
      console.log("[MODE_CHANGE] WhatsApp notification call completed for schedule:", { scheduleId: id, equipmentId, active: patch.active });
    }

    emitAutomationUpdated();
    await refresh();
  }, [farmId, performerName, refresh, schedules]);

  const deleteSchedule = useCallback(async (id: string) => {
    // Stamp who is deleting (audit trigger reads OLD row)
    await supabase
      .from("automation_schedules")
      .update({ last_modified_by_name: performerName, last_modified_by_via: "frontend" })
      .eq("id", id);
    const { error } = await supabase.from("automation_schedules").delete().eq("id", id);
    if (error) throw new Error(error.message);

    emitAutomationUpdated();
    await refresh();
  }, [performerName, refresh]);



  const toggleSchedule = useCallback(async (id: string) => {
    const sch = schedules.find((s) => s.id === id);
    if (!sch) return;
    await updateSchedule(id, { active: !sch.active });
  }, [schedules, updateSchedule]);

  const upsertHoliday = useCallback(async (equipmentId: string, patch: Partial<CloudHolidayConfig>) => {
    if (!farmId) return;

    const current = holidayConfigs[equipmentId] ?? {
      enabled: false,
      mode: "free-demand" as const,
      specialTimeOn: "06:00",
      specialTimeOff: "22:00",
    };
    const merged = { ...current, ...patch };

    const { error } = await supabase
      .from("automation_holiday_configs")
      .upsert({
        farm_id: farmId,
        equipment_id: equipmentId,
        enabled: merged.enabled,
        mode: merged.mode,
        special_time_on: merged.specialTimeOn,
        special_time_off: merged.specialTimeOff,
      }, { onConflict: "farm_id,equipment_id" });

    if (error) throw new Error(error.message);

    emitAutomationUpdated();
    await refresh();
  }, [farmId, holidayConfigs, refresh]);

  return useMemo(() => ({
    loading,
    engineActive,
    schedules,
    holidayConfigs,
    setEngineActive,
    createSchedule,
    updateSchedule,
    deleteSchedule,
    toggleSchedule,
    upsertHoliday,
    refresh,
  }), [loading, engineActive, schedules, holidayConfigs, setEngineActive, createSchedule, updateSchedule, deleteSchedule, toggleSchedule, upsertHoliday, refresh]);
}
