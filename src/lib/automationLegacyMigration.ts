// ─────────────────────────────────────────────────────────────────────────────
// automationLegacyMigration — migra UMA VEZ as programações antigas que ficavam
// em localStorage (`automation_schedules_v1`, `holiday_configs`,
// `automation_engine`) para a nuvem. Após o sucesso, marca um flag por
// fazenda para nunca mais rodar.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from "@/integrations/supabase/client";
import { loadCloudIdMap } from "@/lib/cadastrosCloud";

const LEGACY_SCHEDULES_KEY = "automation_schedules_v1";
const LEGACY_HOLIDAY_KEY = "holiday_configs";
const LEGACY_ENGINE_KEY = "automation_engine";
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface LegacySchedule {
  id: number;
  active: boolean;
  pump: string;
  equipmentId: string;
  mode?: "both" | "on-only" | "off-only";
  days: string[];
  timeOn: string;
  timeOff: string;
}

interface LegacyHoliday {
  enabled: boolean;
  mode: "free-demand" | "special-schedule";
  specialTimeOn: string;
  specialTimeOff: string;
}

const flagKey = (farmId: string) => `automation_legacy_migrated_${farmId}`;

const resolveEquipmentId = (legacyEquipmentId: unknown): string | null => {
  if (typeof legacyEquipmentId === "string" && UUID_REGEX.test(legacyEquipmentId)) {
    return legacyEquipmentId;
  }

  const normalized = String(legacyEquipmentId ?? "").trim();
  if (!normalized) return null;

  const idMap = loadCloudIdMap();
  const mapped = idMap?.equips[Number(normalized)];
  return typeof mapped === "string" && UUID_REGEX.test(mapped) ? mapped : null;
};

export async function migrateLegacyAutomationToCloud(farmId: string): Promise<{
  status: "skipped" | "migrated" | "nothing-to-migrate" | "error";
  schedulesCount?: number;
  holidayCount?: number;
  error?: string;
}> {
  if (!farmId) return { status: "skipped" };

  let schedules: LegacySchedule[] = [];
  let holidays: Record<string, LegacyHoliday> = {};
  let engineEnabled: boolean | null = null;

  try {
    const rawS = localStorage.getItem(LEGACY_SCHEDULES_KEY);
    if (rawS) {
      const parsed = JSON.parse(rawS);
      if (Array.isArray(parsed)) schedules = parsed;
    }
    const rawH = localStorage.getItem(LEGACY_HOLIDAY_KEY);
    if (rawH) {
      const parsed = JSON.parse(rawH);
      if (parsed && typeof parsed === "object") holidays = parsed;
    }
    const rawE = localStorage.getItem(LEGACY_ENGINE_KEY);
    if (rawE !== null) engineEnabled = rawE === "true";
  } catch {
    /* ignore parse */
  }

  if (schedules.length === 0 && Object.keys(holidays).length === 0 && engineEnabled === null) {
    localStorage.setItem(flagKey(farmId), new Date().toISOString());
    return { status: "nothing-to-migrate" };
  }

  try {
    const hasMigrationFlag = !!localStorage.getItem(flagKey(farmId));
    const [
      { count: existingSchedules },
      { count: existingHolidays },
      { count: existingEngineRows },
      { count: equipmentsCount },
    ] = await Promise.all([
      supabase.from("automation_schedules").select("id", { count: "exact", head: true }).eq("farm_id", farmId),
      supabase.from("automation_holiday_configs").select("id", { count: "exact", head: true }).eq("farm_id", farmId),
      supabase.from("automation_engine").select("farm_id", { count: "exact", head: true }).eq("farm_id", farmId),
      supabase.from("equipments").select("id", { count: "exact", head: true }).eq("farm_id", farmId),
    ]);

    const needsSchedulesMigration = schedules.length > 0 && (existingSchedules ?? 0) === 0;
    const needsHolidaysMigration = Object.keys(holidays).length > 0 && (existingHolidays ?? 0) === 0;
    const needsEngineMigration = engineEnabled !== null && (existingEngineRows ?? 0) === 0;

    if (hasMigrationFlag && !needsSchedulesMigration && !needsHolidaysMigration && !needsEngineMigration) {
      return { status: "skipped" };
    }

    if ((needsSchedulesMigration || needsHolidaysMigration) && (equipmentsCount ?? 0) === 0) {
      return { status: "skipped" };
    }

    let migratedSchedules = 0;
    if (needsSchedulesMigration) {
      const normalizedSchedules = schedules
        .map((schedule) => ({ ...schedule, equipmentId: resolveEquipmentId(schedule.equipmentId) }))
        .filter((schedule): schedule is LegacySchedule & { equipmentId: string } => !!schedule.equipmentId);

      const equipmentIds = Array.from(new Set(normalizedSchedules.map((s) => s.equipmentId)));
      const { data: validEqs } = await supabase
        .from("equipments")
        .select("id")
        .eq("farm_id", farmId)
        .in("id", equipmentIds);
      const validSet = new Set((validEqs ?? []).map((e) => e.id));

      const rows = normalizedSchedules
        .filter((s) => validSet.has(s.equipmentId))
        .flatMap((s) => {
          const base = {
            farm_id: farmId,
            equipment_id: s.equipmentId,
            active: !!s.active,
            days: Array.isArray(s.days) ? s.days : [],
            time_on: s.timeOn || "06:00",
            time_off: s.timeOff || "22:00",
          };
          const legacyMode = s.mode ?? "both";
          // 'both' legado vira duas programações: ligar + desligar
          if (legacyMode === "both") {
            return [
              { ...base, mode: "on-only" },
              { ...base, mode: "off-only" },
            ];
          }
          return [{ ...base, mode: legacyMode }];
        });

      if (rows.length > 0) {
        const { error } = await supabase.from("automation_schedules").insert(rows);
        if (error) return { status: "error", error: error.message };
        migratedSchedules = rows.length;
      }
    }

    let migratedHolidays = 0;
    const holidayEntries = Object.entries(holidays);
    if (needsHolidaysMigration) {
      const normalizedHolidayEntries = holidayEntries
        .map(([eqId, value]) => [resolveEquipmentId(eqId), value] as const)
        .filter((entry): entry is readonly [string, LegacyHoliday] => !!entry[0]);

      const equipmentIds = normalizedHolidayEntries.map(([eqId]) => eqId);
      const { data: validEqs } = await supabase
        .from("equipments")
        .select("id")
        .eq("farm_id", farmId)
        .in("id", equipmentIds);
      const validSet = new Set((validEqs ?? []).map((e) => e.id));

      const rows = normalizedHolidayEntries
        .filter(([eqId]) => validSet.has(eqId))
        .map(([eqId, h]) => ({
          farm_id: farmId,
          equipment_id: eqId,
          enabled: !!h.enabled,
          mode: h.mode ?? "free-demand",
          special_time_on: h.specialTimeOn || "06:00",
          special_time_off: h.specialTimeOff || "22:00",
        }));

      if (rows.length > 0) {
        const { error } = await supabase
          .from("automation_holiday_configs")
          .upsert(rows, { onConflict: "farm_id,equipment_id" });
        if (error) return { status: "error", error: error.message };
        migratedHolidays = rows.length;
      }
    }

    if (engineEnabled !== null) {
      const { error } = await supabase
        .from("automation_engine")
        .upsert({ farm_id: farmId, enabled: engineEnabled }, { onConflict: "farm_id" });
      if (error) return { status: "error", error: error.message };
    }

    localStorage.setItem(flagKey(farmId), new Date().toISOString());

    return {
      status: "migrated",
      schedulesCount: migratedSchedules,
      holidayCount: migratedHolidays,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: "error", error: msg };
  }
}
