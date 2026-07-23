// ─────────────────────────────────────────────────────────────────────────────
// automationProtectiveOff
// Quando o automático é desativado (motor global ou programação individual)
// e a bomba está DENTRO da janela de horário programada mas o `last_outputs_state`
// indica que ela está DESLIGADA, enviamos um comando OFF (payload "0") explícito
// para forçar a sincronização do PLC físico. Isso evita o cenário onde a bomba
// "deveria estar ligada" pelo automático, mas algo no campo a manteve desligada,
// e ao desativar o automático nada é enviado — deixando o estado físico ambíguo.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from "@/integrations/supabase/client";
import type { CloudPlc, CloudEquipamento } from "@/hooks/useCadastrosCloud";
import type { CloudSchedule, CloudHolidayConfig } from "@/hooks/useCloudAutomation";
import { buildPositionalPayload } from "@/lib/rfRouting";

const HOLIDAYS_MMDD = [
  "01-01", "04-21", "05-01", "09-07", "10-12", "11-02", "11-15", "12-25",
];

const DOW_KEYS = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"];

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
};

const localPartsForFarm = (now: Date, timezone: string) => {
  // Usa Intl para extrair partes no fuso da fazenda
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "America/Sao_Paulo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  });
  const parts = fmt.formatToParts(now).reduce<Record<string, string>>((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const dowMap: Record<string, string> = {
    Sun: "dom", Mon: "seg", Tue: "ter", Wed: "qua", Thu: "qui", Fri: "sex", Sat: "sab",
  };
  const dowKey = dowMap[parts.weekday ?? "Mon"] ?? "seg";
  const hhmm = `${parts.hour}:${parts.minute}`;
  const mmdd = `${parts.month}-${parts.day}`;
  return { dowKey, hhmm, mmdd };
};

const isInsideWindow = (nowMin: number, onMin: number, offMin: number) => {
  if (onMin <= offMin) return nowMin >= onMin && nowMin < offMin;
  return nowMin >= onMin || nowMin < offMin;
};

const isOutputOff = (eq: CloudEquipamento): boolean => {
  const state = eq.last_outputs_state ?? "000000";
  const idx = (eq.saida ?? 1) - 1;
  if (/^[01]{6}$/.test(state) && idx >= 0 && idx < 6) return state[idx] === "0";
  if (/^[01]$/.test(state)) return state === "0";
  return true; // sem leitura confiável → trata como off
};

const buildOffFrame = (tsnn: string, saida: number | null | undefined): string =>
  `[${tsnn}_1_]{${buildPositionalPayload(saida ?? 1, false)}}[${tsnn}_ETX_]\r`;

interface EnqueueParams {
  farmId: string;
  timezone: string;
  schedules: CloudSchedule[];
  equipments: CloudEquipamento[];
  plcs: CloudPlc[];
  holidayConfigs: Record<string, CloudHolidayConfig>;
  /** Se informado, considera apenas este schedule (toggle individual). */
  scheduleIdScope?: string;
}

/**
 * Enfileira um comando OFF (payload "0") para cada bomba cujo schedule está
 * sendo desativado/silenciado, esteja dentro da janela e cujo last_outputs_state
 * indica desligada. Retorna a quantidade de comandos enfileirados.
 */
export async function enqueueProtectiveOffOnDisable(params: EnqueueParams): Promise<number> {
  const { farmId, timezone, schedules, equipments, plcs, holidayConfigs, scheduleIdScope } = params;
  if (!farmId) return 0;

  const now = new Date();
  const { dowKey, hhmm, mmdd } = localPartsForFarm(now, timezone);
  const nowMin = toMinutes(hhmm);
  const isHoliday = HOLIDAYS_MMDD.includes(mmdd);

  // Schedules candidatos
  const candidateScheds = schedules.filter((s) => {
    if (!s.active) return false;
    if (scheduleIdScope && s.id !== scheduleIdScope) return false;
    if (s.mode === "off-only") return false; // só faz sentido para programações que ligam
    return true;
  });

  // Para evitar duplicidade quando a mesma bomba tem múltiplas programações ativas
  const equipmentsToShutdown = new Set<string>();

  for (const sch of candidateScheds) {
    const eq = equipments.find((e) => e.id === sch.equipmentId);
    if (!eq || !eq.active) continue;
    if (eq.type !== "poco" && eq.type !== "bombeamento") continue;

    let effOn = sch.timeOn;
    let effOff = sch.timeOff;
    let skipDayCheck = false;

    if (isHoliday) {
      const cfg = holidayConfigs[sch.equipmentId];
      if (cfg?.enabled) {
        if (cfg.mode === "free-demand") continue;
        if (cfg.mode === "special-schedule") {
          effOn = cfg.specialTimeOn;
          effOff = cfg.specialTimeOff;
          skipDayCheck = true;
        }
      }
    }

    if (!skipDayCheck && !sch.days.includes(dowKey)) continue;

    const onMin = toMinutes(effOn);
    const offMin = toMinutes(effOff);
    if (!isInsideWindow(nowMin, onMin, offMin)) continue;

    if (!isOutputOff(eq)) continue; // se a bomba está ligada, NÃO mandamos off (usuário só pediu o cenário "estado desligado")

    equipmentsToShutdown.add(eq.id);
  }

  if (equipmentsToShutdown.size === 0) return 0;

  const inserts = Array.from(equipmentsToShutdown).map((eqId) => {
    const eq = equipments.find((e) => e.id === eqId)!;
    const plc = eq.plc_group_id ? plcs.find((p) => p.id === eq.plc_group_id) : undefined;
    const tsnn = plc?.hw_id ?? eq.hw_id.substring(0, 4);
    return {
      farm_id: farmId,
      equipment_id: eq.id,
      plc_hw_id: tsnn,
      type: "manual" as const,
      priority: 1,
      frame: buildOffFrame(tsnn, eq.saida),
      timeout_ms: 600000,
      source_device: "cloud-automation-disable",
    };
  });

  const { error } = await supabase.from("commands").insert(inserts);
  if (error) {
    console.error("[protective-off] insert error", error);
    throw new Error(error.message);
  }
  return inserts.length;
}
