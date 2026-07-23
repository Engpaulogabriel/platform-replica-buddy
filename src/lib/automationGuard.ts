// ─────────────────────────────────────────────────────────────────────────────
// automationGuard — desativa automaticamente as programações de uma bomba
// quando ela é desligada SEM que o automático tenha disparado o desligamento
// (ex.: queda de fase, reset físico, alguém girou a chave local).
//
// AGORA totalmente na nuvem (tabela `automation_guards`). Cada fazenda enxerga
// seu próprio estado em qualquer dispositivo, e o disparo persiste mesmo se o
// navegador for fechado.
// ─────────────────────────────────────────────────────────────────────────────
import { supabase } from "@/integrations/supabase/client";

export interface GuardEntry {
  equipmentId: string;
  pumpName: string;
  silencedScheduleIds: string[];
  triggeredAt: string;
}

function emitUpdated() {
  try {
    window.dispatchEvent(new Event("automation-guard:updated"));
  } catch { /* ignore */ }
}

/**
 * Verifica se houve disparo programado de "off" recentemente para o
 * equipamento (lê `automation_fired` + `automation_schedules` da nuvem).
 */
export async function wasScheduledOffRecently(
  farmId: string,
  equipmentId: string,
  windowMs: number,
): Promise<boolean> {
  try {
    const { data: schedules } = await supabase
      .from("automation_schedules")
      .select("id, time_off")
      .eq("farm_id", farmId)
      .eq("equipment_id", equipmentId);
    if (!schedules || schedules.length === 0) return false;

    const ids = schedules.map((s) => s.id);
    const since = new Date(Date.now() - windowMs).toISOString();

    const { data: fired } = await supabase
      .from("automation_fired")
      .select("schedule_id, fired_key, fired_at")
      .in("schedule_id", ids)
      .gte("fired_at", since);

    if (!fired || fired.length === 0) return false;
    return fired.some((f) => typeof f.fired_key === "string" && f.fired_key.includes("|off@"));
  } catch {
    return false;
  }
}

/**
 * NEUTRALIZADO: a função era responsável por desativar programações e marcar
 * a bomba como "fora da automação". Por decisão do produto, o sistema NUNCA
 * deve desativar programações ou alternar o modo automático automaticamente.
 * Apenas o usuário, via UI, pode tomar essas ações. Mantemos a função
 * exportada (no-op) para preservar compatibilidade de chamadas existentes.
 */
export async function triggerAutomationGuard(
  _farmId: string,
  _equipmentId: string,
  _pumpName: string,
): Promise<GuardEntry | null> {
  return null;
}

/**
 * Limpa eventual registro legado de guard. NÃO altera mais o estado `active`
 * das programações — programações só são modificadas por ação do usuário.
 */
export async function clearAutomationGuard(
  farmId: string,
  equipmentId: string,
): Promise<number> {
  try {
    await supabase
      .from("automation_guards")
      .delete()
      .eq("farm_id", farmId)
      .eq("equipment_id", equipmentId);
    emitUpdated();
    return 0;
  } catch {
    return 0;
  }
}

export async function getAllAutomationGuards(_farmId: string): Promise<Record<string, GuardEntry>> {
  return {};
}
