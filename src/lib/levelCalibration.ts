// ─────────────────────────────────────────────────────────────────────────────
// levelCalibration — converte leitura digital N1/N2 (raw int) em metros e %.
//
// Modelo: 1 ponto + nível máximo (regra de três simples).
//   metros_atual  = (raw / cal_digital) * cal_meters
//   porcentagem   = (metros_atual / level_max_meters) * 100
//
// Quando faltam pontos de calibração ou level_max_meters, retorna meters=null
// e percent calculado como % bruta sobre max_height (compat com o comportamento
// antigo do Dashboard, que mostrava só porcentagem).
// ─────────────────────────────────────────────────────────────────────────────

export interface LevelCalInput {
  raw: number | null | undefined;
  cal_digital: number | null | undefined;
  cal_meters: number | null | undefined;
  max_meters: number | null | undefined;
  /** fallback antigo (max_height do reservatório) — usado só quando não há calibração. */
  max_height?: number | null | undefined;
}

export interface LevelCalResult {
  meters: number | null;       // metros calculados (null se não calibrado)
  percent: number | null;      // 0-100 (null se não dá pra calcular)
  isCalibrated: boolean;       // true se cal_digital + cal_meters preenchidos e válidos
}

const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

export function calibrateLevel(input: LevelCalInput): LevelCalResult {
  const { raw, cal_digital, cal_meters, max_meters, max_height } = input;

  const calibrated =
    isNum(cal_digital) && cal_digital > 0 &&
    isNum(cal_meters) && cal_meters > 0;

  if (!isNum(raw)) {
    return { meters: null, percent: null, isCalibrated: calibrated };
  }

  if (calibrated) {
    // Regra de três: meters = raw * (cal_meters / cal_digital)
    const meters = (raw / (cal_digital as number)) * (cal_meters as number);
    const safeMeters = Math.max(0, meters);

    const maxRef = isNum(max_meters) && max_meters > 0
      ? max_meters
      : (isNum(max_height) && max_height > 0 ? max_height : null);

    let percent: number | null = null;
    if (maxRef !== null) {
      percent = Math.max(0, Math.min(100, (safeMeters / maxRef) * 100));
    }
    return { meters: safeMeters, percent, isCalibrated: true };
  }

  // Fallback: sem calibração — mostra só % bruta se houver max_height
  // (assumindo raw normalizado 0-1023 como aproximação).
  if (isNum(max_height) && max_height > 0) {
    const approx = Math.max(0, Math.min(100, (raw / 1023) * 100));
    return { meters: null, percent: approx, isCalibrated: false };
  }

  return { meters: null, percent: null, isCalibrated: false };
}

/** Formata "1.61 m (32%)" para o Dashboard. */
export function formatLevelDisplay(r: LevelCalResult): string {
  if (r.meters !== null && r.percent !== null) {
    return `${r.meters.toFixed(2)} m (${r.percent.toFixed(0)}%)`;
  }
  if (r.meters !== null) return `${r.meters.toFixed(2)} m`;
  if (r.percent !== null) return `${r.percent.toFixed(0)}%`;
  return "—";
}
