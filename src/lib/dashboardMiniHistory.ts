// ─────────────────────────────────────────────────────────────────────────────
// dashboardMiniHistory — fonte ÚNICA do mini relatório do PumpCard/PumpTable.
//
// ISOLADO DE PROPÓSITO. O Relatório de Automação oficial (tela, CSV e PDF) está
// certificado; mudança de dashboard não pode alcançá-lo. Este módulo NÃO usa
// nem exporta nada do Relatório de Automação oficial: nem o componente da
// aba, nem o módulo de exportação, nem as funções de carga ou higienização.
//
// Os vocabulários são distintos de propósito: o oficial diz "Local (painel)";
// aqui dizemos "Acionamento local".
// ─────────────────────────────────────────────────────────────────────────────
import type { AutomationLogEntry, AutomationAction, AutomationOrigin } from "./automationLog";
import type { PumpCommandLog, PumpStatusLog } from "@/components/dashboard/PumpTable";

/** "Manual" no relatório = acionamento físico (Local) no equipamento. */
export const isLocalOrigin = (origin: AutomationOrigin) => origin === "Manual";

/** Origem do MINI RELATÓRIO — versão compacta do Relatório de Automação.
 *  Preserva as cinco origens canônicas. É PROIBIDO reduzir Automação ou
 *  WhatsApp para Remoto, ou qualquer origem para Local. */
export type MiniOrigin = "local" | "remoto" | "whatsapp" | "auto" | "automatico";

export const miniOrigin = (e: AutomationLogEntry): MiniOrigin =>
  e.origin === "Manual"       ? "local"
  : e.origin === "WhatsApp"   ? "whatsapp"
  // `scheduled !== false`: indefinido conta como PROGRAMADA. Na plataforma,
  // origin 'auto' é a regra com horário; só evidência positiva de modo
  // automático (scheduled === false) vira "AUTO".
  : e.origin === "Automático" ? (e.scheduled === false ? "automatico" : "auto")
  : "remoto";

export const MINI_ORIGIN_LABEL: Record<MiniOrigin, string> = {
  local:      "LOCAL",
  remoto:     "REMOTO",
  whatsapp:   "WHATSAPP",
  auto:       "AUTOMAÇÃO",
  automatico: "AUTO",
};

/** Cor do badge por origem. Fica AQUI, junto da classificação, para tela e
 *  card não divergirem. */
/** Barras de comunicação pela idade da ÚLTIMA RESPOSTA FÍSICA.
 *  ≤5min → 4 · ≤8min → 3 · ≤11min → 2 · <15min → 1 · ≥15min → 0.
 *  Não é RSSI, não é potência de rádio, não é o horário do último TX. */
export const commBarsFor = (ageMs: number): 0 | 1 | 2 | 3 | 4 => {
  const min = ageMs / 60_000;
  if (min <= 5) return 4;
  if (min <= 8) return 3;
  if (min <= 11) return 2;
  if (min < 15) return 1;
  return 0;
};

export const MINI_ORIGIN_CLASS: Record<MiniOrigin, string> = {
  remoto:     "bg-info/15 text-info border-info/40",                 // azul
  automatico: "bg-info/15 text-info border-info/40",                 // azul
  local:      "bg-warning/15 text-warning border-warning/40",        // amarelo
  auto:       "bg-primary/15 text-primary border-primary/40",        // verde
  whatsapp:   "bg-primary/15 text-primary border-primary/40",        // verde
};

/** Rótulos que são MÉTODO DE TRANSPORTE ou entidade técnica — nunca pessoa,
 *  regra ou canal. "Telemetria RF" é como a confirmação chegou, não quem
 *  mandou. Se um destes aparecer no lugar do autor, é vazamento: o mini
 *  relatório prefere não mostrar nada a mostrar isto. */
const ROTULO_TECNICO =
  /^(telemetria(\s*rf)?|acionamento\s*rf|rf|bridge|serial(-bridge)?|sistema|system|agente?|agent|cloud|auto-trigger|unknown|n\/a|desconhecido)$/i;

/** UUID cru ou id técnico jamais vira nome de gente. */
const PARECE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-|^[0-9a-f]{24,}$/i;

export const isTechnicalLabel = (v?: string | null): boolean => {
  const t = (v ?? "").trim();
  if (!t) return true;
  return ROTULO_TECNICO.test(t) || PARECE_ID.test(t);
};

/** Rótulo à direita da origem: regra, pessoa ou canal. Nunca genérico,
 *  nunca método técnico. */
export const miniActor = (e: AutomationLogEntry): string | null => {
  const o = miniOrigin(e);
  if (o === "local") return "Acionamento local";
  let nome = (e.user ?? "").trim();
  // "WhatsApp · Fulano" → o badge já diz WhatsApp; aqui fica só a pessoa.
  if (o === "whatsapp" && /^whatsapp\s*[·:-]\s*/i.test(nome)) {
    nome = nome.replace(/^whatsapp\s*[·:-]\s*/i, "").trim();
  }
  return isTechnicalLabel(nome) ? null : nome;
};

/** Formata data+hora curta para o mini-relatório: "DD/MM HH:mm" */
const shortTime = (e: AutomationLogEntry) => {
  const [dd, mm] = e.date.split("/");
  return `${dd}/${mm} ${e.time}`;
};

/** Filtra entradas por equipamento. Cruza por equipmentId quando presente,
 *  cai no nome para entradas antigas. */
const matchEquipment = (e: AutomationLogEntry, equipmentId: string, pumpName: string) =>
  e.equipmentId ? e.equipmentId === equipmentId : e.pump === pumpName;

/** Só comandos reais entram no mini-relatório do card. Leitura OK / Sem
 *  resposta / eventos de sistema (OTA, reinício) são ruído e ficam de fora. */
const isCommandAction = (a: AutomationAction) => a === "Ligada" || a === "Desligada";

export function buildMiniCommandHistory(
  equipmentId: string,
  pumpName: string,
  entries: AutomationLogEntry[],
  limit = 3,
): PumpCommandLog[] {
  return entries
    .filter((e) => isCommandAction(e.action) && matchEquipment(e, equipmentId, pumpName))
    .slice(0, limit)
    .map((e) => {
      const o = miniOrigin(e);
      const verb = e.action === "Ligada" ? "Ligar" : "Desligar";
      const result: "success" | "fail" =
        o === "local" ? "success" : (e.result ?? "success");
      return {
        action: `${verb} ${MINI_ORIGIN_LABEL[o].toLowerCase()}`,
        time: shortTime(e),
        result,
        source: o,
        label: MINI_ORIGIN_LABEL[o],
        // Automação mostra a REGRA; remoto/WhatsApp mostram a PESSOA.
        actor: miniActor(e),
      };
    });
}

export function buildMiniStatusHistory(
  equipmentId: string,
  pumpName: string,
  entries: AutomationLogEntry[],
  limit = 3,
): PumpStatusLog[] {
  return entries
    .filter(
      (e) =>
        isCommandAction(e.action) &&
        matchEquipment(e, equipmentId, pumpName) &&
        (e.result ?? "success") === "success",
    )
    .slice(0, limit)
    .map((e) => {
      const o = miniOrigin(e);
      return {
        status: (e.action === "Ligada" ? "Ligado" : "Desligado") as "Ligado" | "Desligado",
        source: o,
        time: shortTime(e),
        label: MINI_ORIGIN_LABEL[o],
        actor: miniActor(e),
      };
    });
}