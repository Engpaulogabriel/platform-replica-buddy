// ─────────────────────────────────────────────────────────────────────────────
// reportOrigin — coluna ORIGEM do Relatório de Automação.
// ─────────────────────────────────────────────────────────────────────────────
// A coluna tinha seis rótulos e misturava dois eixos: de onde veio a ordem
// (remoto × local) e por qual canal ela chegou (WhatsApp, motor da nuvem,
// desligamento programado). O operador lia "WhatsApp" e "Automação" como se
// fossem origens concorrentes de "Remoto", quando são a mesma origem.
//
// Agora são duas: REMOTO e LOCAL. Quem ou o quê agiu vai na coluna NOME.
// Camada de APRESENTAÇÃO: nada muda no banco nem em `AutomationOrigin`.
//
// Módulo PURO (sem JSX, sem React): é o que torna a regra testável de verdade.

import type { AutomationOrigin } from "./automationLog";

/** A coluna ORIGEM tem DUAS categorias, e só duas.
 *
 *  REMOTO = o comando partiu do sistema — plataforma, WhatsApp, Modo
 *  Automático, desligamento programado. Quem foi está na coluna NOME:
 *  "Yuri Seibert", "Alcione Costa", "Desligamento 17h".
 *
 *  LOCAL  = a bomba mudou de estado sem comando correlacionado.
 *
 *  Canal não é origem: WhatsApp é como a ordem chegou, não de onde ela veio.
 *  Por isso "WhatsApp", "Automação" e "Modo Automático" deixaram de ser
 *  categorias visuais — viraram o NOME. */
export type ReportOrigin = "Remoto" | "Local";

/** Ícone por origem exibida. O nome é resolvido para o componente lucide no
 *  componente — aqui fica só a decisão, que é o que precisa de teste. */
export type ReportOriginIcon =
  | "Monitor" | "Hand" | "Workflow" | "Bot" | "MessageCircle" | "Server";

/** `source_device` do motor do Modo Automático. É o MESMO valor que
 *  `run_automation_tick` e `run_peak_hour_tick` gravam em `commands`. */
export const AUTO_ENGINE_SOURCE = "cloud-automation";

/** Decide o rótulo da coluna ORIGEM: houve comando do sistema, ou não. */
export function resolveReportOrigin(
  origin: AutomationOrigin | string,
  _sourceDevice?: string | null,
): ReportOrigin {
  // "Manual" é o rótulo interno de origin='local' — atuação declarada pela
  // telemetria. "Sistema" cobre origin='system': transição física real que
  // nenhuma correlação explicou. Nos dois casos não houve comando do sistema,
  // e é isso que a coluna comunica.
  if (origin === "Manual" || origin === "Sistema") return "Local";
  return "Remoto";
}

/** Ícone por origem exibida. A mão é do Local e de mais ninguém. */
export const REPORT_ORIGIN_ICON: Record<ReportOrigin, ReportOriginIcon> = {
  "Remoto": "Monitor",
  "Local":  "Hand",
};

/** Classe de COR do ícone. */
export const REPORT_ORIGIN_ICON_CLASS: Record<ReportOrigin, string> = {
  "Remoto": "text-info",
  "Local":  "text-warning",
};

/** Classe do badge (pílula) na tabela. */
export const REPORT_ORIGIN_BADGE: Record<ReportOrigin, string> = {
  "Remoto": "bg-info/10 text-info",
  "Local":  "bg-warning/15 text-warning border border-warning/30",
};
