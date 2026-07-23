// Lógica de classificação tarifária Coelba (Rural Irrigante - 4 faixas)
// RESERVADA:    21:30 → 06:00 (todos os dias)         — mais barata
// FORA-PONTA:   06:00 → 17:00 (todos os dias)
// INTERMEDIÁRIA:17:00 → 18:00 e 21:00 → 21:30 (dias úteis)
// PONTA:        18:00 → 21:00 (dias úteis, não feriado) — mais cara
// Em fins de semana / feriados as janelas de ponta e intermediária viram fora-ponta
// (apenas a reservada noturna se mantém).

export type TariffPost = "peak" | "intermediate" | "reserved" | "off_peak";

export interface TariffRates {
  off_peak: number;
  peak: number;
  reserved: number;
  intermediate: number;
}

/**
 * Classifica um instante (timezone local) num posto tarifário.
 * @param d data/hora local
 * @param holidays Set de strings YYYY-MM-DD (feriados nacionais)
 */
export function classifyInstant(d: Date, holidays: Set<string>): TariffPost {
  const dow = d.getDay(); // 0=dom, 6=sab
  const minutes = d.getHours() * 60 + d.getMinutes();
  const dateKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const isWeekend = dow === 0 || dow === 6;
  const isHoliday = holidays.has(dateKey);
  const isWorkday = !isWeekend && !isHoliday;

  // Reservado: 21:30–06:00 (sempre)
  if (minutes >= 21 * 60 + 30 || minutes < 6 * 60) return "reserved";

  if (isWorkday) {
    // Ponta: 18:00–21:00 dias úteis
    if (minutes >= 18 * 60 && minutes < 21 * 60) return "peak";
    // Intermediária pré-ponta: 17:00–18:00
    if (minutes >= 17 * 60 && minutes < 18 * 60) return "intermediate";
    // Intermediária pós-ponta: 21:00–21:30
    if (minutes >= 21 * 60 && minutes < 21 * 60 + 30) return "intermediate";
  }

  // Resto do dia (06:00–17:00 e janelas equivalentes em fim de semana/feriado)
  return "off_peak";
}

/**
 * Recebe início/fim de uma sessão de bombeamento e devolve quantas horas
 * em cada posto tarifário ela consumiu, fatiando em janelas de 5 min.
 */
export function splitSessionByPost(
  start: Date,
  end: Date,
  holidays: Set<string>,
): Record<TariffPost, number> {
  const out: Record<TariffPost, number> = { peak: 0, intermediate: 0, reserved: 0, off_peak: 0 };
  if (end <= start) return out;
  const stepMs = 5 * 60 * 1000;
  let t = start.getTime();
  const endMs = end.getTime();
  while (t < endMs) {
    const next = Math.min(t + stepMs, endMs);
    const slice = (next - t) / 3_600_000;
    const mid = new Date((t + next) / 2);
    out[classifyInstant(mid, holidays)] += slice;
    t = next;
  }
  return out;
}

/** Verifica se "agora" cai em horário de ponta. */
export function isPeakNow(holidays: Set<string>, now = new Date()): boolean {
  return classifyInstant(now, holidays) === "peak";
}

/** Verifica se "agora" cai na janela intermediária (17-18h ou 21-21:30). */
export function isIntermediateNow(holidays: Set<string>, now = new Date()): boolean {
  return classifyInstant(now, holidays) === "intermediate";
}

export function computeEnergyCost(
  hoursByPost: Record<TariffPost, number>,
  powerKw: number,
  rates: TariffRates,
): { kwh: Record<TariffPost, number>; cost: Record<TariffPost, number>; total: number } {
  const kwh: Record<TariffPost, number> = {
    peak: hoursByPost.peak * powerKw,
    intermediate: hoursByPost.intermediate * powerKw,
    reserved: hoursByPost.reserved * powerKw,
    off_peak: hoursByPost.off_peak * powerKw,
  };
  const cost: Record<TariffPost, number> = {
    peak: kwh.peak * rates.peak,
    intermediate: kwh.intermediate * rates.intermediate,
    reserved: kwh.reserved * rates.reserved,
    off_peak: kwh.off_peak * rates.off_peak,
  };
  return { kwh, cost, total: cost.peak + cost.intermediate + cost.reserved + cost.off_peak };
}
