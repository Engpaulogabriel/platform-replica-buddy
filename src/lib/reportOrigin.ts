// ─────────────────────────────────────────────────────────────────────────────
// reportOrigin — coluna ORIGEM do Relatório de Automação.
// ─────────────────────────────────────────────────────────────────────────────
// PROBLEMA: "Automação" agrupava dois motores que o produto trata como coisas
// distintas — o desligamento programado (`scheduled-shutdown`) e o Modo
// Automático da nuvem (`run_automation_tick`). Na tela os dois saíam iguais.
//
// SEM MIGRATION: `source_device` já vem na linha do banco e já é usado por
// `classifyAction`. A separação é derivada dele no frontend; nada muda no
// banco, na classificação de `origin` nem em `AutomationOrigin` — as cinco
// origens canônicas continuam as mesmas. Isto é camada de APRESENTAÇÃO.
//
// Módulo PURO (sem JSX, sem React): é o que torna a regra testável de verdade.

import type { AutomationOrigin } from "./automationLog";

/** Rótulos exibidos na coluna ORIGEM. Superset de AutomationOrigin: "Automático"
 *  se desdobra em dois, o resto é 1:1. */
export type ReportOrigin =
  | "Remoto" | "Local" | "Automação" | "Modo Automático" | "WhatsApp" | "Sistema";

/** Ícone por origem exibida. O nome é resolvido para o componente lucide no
 *  componente — aqui fica só a decisão, que é o que precisa de teste. */
export type ReportOriginIcon =
  | "Monitor" | "Hand" | "Workflow" | "Bot" | "MessageCircle" | "Server";

/** `source_device` do motor do Modo Automático. É o MESMO valor que
 *  `run_automation_tick` e `run_peak_hour_tick` gravam em `commands`. */
export const AUTO_ENGINE_SOURCE = "cloud-automation";

/**
 * Decide o rótulo da coluna ORIGEM.
 *
 * Só `origin === "Automático"` se desdobra, e só quando o `source_device` é
 * exatamente o do motor. Qualquer outra automação — `scheduled-shutdown`,
 * `backend-reset:*`, aba Automações — continua "Automação". Um `source_device`
 * ausente também continua "Automação": na dúvida, o genérico, nunca o
 * específico.
 */
export function resolveReportOrigin(
  origin: AutomationOrigin | string,
  sourceDevice?: string | null,
): ReportOrigin {
  if (origin === "Manual") return "Local";
  // Já classificado como motor da nuvem pelo classifyAction (source_device ou
  // authorship_source=cloud_automation): permanece Modo Automático.
  if (origin === "Modo Automático") return "Modo Automático";
  if (origin === "Automático") {
    const src = String(sourceDevice ?? "").trim().toLowerCase();
    return src === AUTO_ENGINE_SOURCE ? "Modo Automático" : "Automação";
  }
  if (origin === "Remoto" || origin === "WhatsApp" || origin === "Sistema") return origin;
  // Valor cru e desconhecido: mostra como veio, sem inventar rótulo. Mesma
  // política do getOriginLabel anterior.
  return origin as ReportOrigin;
}

/** Ícone por origem exibida. Os quatro casos do produto são MUTUAMENTE
 *  EXCLUSIVOS: nenhuma origem automática pode usar a mão do Local. */
export const REPORT_ORIGIN_ICON: Record<ReportOrigin, ReportOriginIcon> = {
  "Remoto":          "Monitor",
  "Local":           "Hand",
  "Automação":       "Workflow",       // rotinas programadas do sistema
  "Modo Automático": "Bot",            // motor da nuvem (cloud-automation)
  "WhatsApp":        "MessageCircle",
  "Sistema":         "Server",
};

/** Classe de COR do ícone. Remoto, Automação e Modo Automático são AZUL
 *  (`--info`, hue 210) e se distinguem pelo ícone, não pela cor. */
export const REPORT_ORIGIN_ICON_CLASS: Record<ReportOrigin, string> = {
  "Remoto":          "text-info",
  "Local":           "text-warning",
  "Automação":       "text-info",
  "Modo Automático": "text-info",
  "WhatsApp":        "text-[#25D366]",
  "Sistema":         "text-muted-foreground",
};

/** Classe do badge (pílula) na tabela. */
export const REPORT_ORIGIN_BADGE: Record<ReportOrigin, string> = {
  "Remoto":          "bg-info/10 text-info",
  "Local":           "bg-warning/15 text-warning border border-warning/30",
  "Automação":       "bg-info/10 text-info",
  "Modo Automático": "bg-info/10 text-info",
  "WhatsApp":        "bg-[#25D366]/10 text-[#1ea952] border border-[#25D366]/30",
  "Sistema":         "bg-secondary text-muted-foreground",
};
