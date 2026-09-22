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
import { sanitizeOfficialLabel } from "./automationLog";

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

/** O par ORIGEM × NOME, derivado de UMA vez só. */
export interface ReportAttribution {
  origin: ReportOrigin;
  /** Vazio quando a linha é Remota e não há ator comprovável. A tela mostra
   *  travessão; nunca "Acionamento local", que é afirmação de outra coisa. */
  name: string;
}

/** Rótulos internos que significam "houve comando do sistema". */
const COM_RESPONSABILIDADE_REMOTA: ReadonlySet<string> =
  new Set(["Remoto", "WhatsApp", "Automático", "Modo Automático"]);

/**
 * Origem e nome saem da MESMA pergunta: existe responsabilidade remota
 * comprovada por esta transição?
 *
 * Existiam duas funções independentes — uma decidindo a coluna Origem pelo
 * `origin`, outra o Nome pelo `actor_label` — e elas podiam se contradizer.
 * Foi o que produziu "Remoto · Acionamento local" na Sykue: o componente
 * aplicava a resolução de origem DUAS vezes, e a segunda recebia "Local", que
 * não era nem "Manual" nem "Sistema" e caía no `else` → "Remoto". O nome, que
 * vinha de outro caminho, continuava "Acionamento local".
 *
 * Esta função é idempotente de propósito: recebe tanto o rótulo interno
 * ("Manual", "WhatsApp"…) quanto a própria saída ("Local", "Remoto"). Aplicar
 * duas vezes dá o mesmo resultado — a contradição deixa de ser representável.
 */
export function deriveReportAttribution(linha: {
  origin: AutomationOrigin | ReportOrigin | string;
  user?: string | null;
}): ReportAttribution {
  const remota = COM_RESPONSABILIDADE_REMOTA.has(String(linha.origin));
  if (!remota) {
    // Sem comando responsável: "Manual" (origin='local'), "Sistema"
    // (origin='system', transição sem correlação) e a própria saída "Local".
    return { origin: "Local", name: "Acionamento local" };
  }
  // Rótulo técnico ("Telemetria RF", "Sistema", UUID) não é pessoa e é
  // descartado aqui, não na renderização. "Acionamento local" também: numa
  // linha remota ele é contradição, não nome — e afirmar acionamento local
  // numa transição que teve comando seria mentir sobre o que aconteceu.
  // Sem ator comprovável, o nome fica vazio e a tela mostra travessão.
  const nome = sanitizeOfficialLabel(linha.user);
  const ehRotuloDeLocal =
    nome.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase()
      === "acionamento local";
  return { origin: "Remoto", name: ehRotuloDeLocal ? "" : nome };
}

/** Só a coluna ORIGEM. Atalho sobre a derivação única — nunca uma segunda
 *  heurística. */
export function resolveReportOrigin(
  origin: AutomationOrigin | string,
  _sourceDevice?: string | null,
): ReportOrigin {
  return deriveReportAttribution({ origin }).origin;
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
