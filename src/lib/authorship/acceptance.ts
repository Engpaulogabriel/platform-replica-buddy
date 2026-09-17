// Auditor de aceitação do Relatório de Automação (espelho TS das regras do banco).
// Cada critério aparece UMA única vez, e fazenda sem eventos entra com contagem zero.

export interface AuditEvent {
  farm_id: string;
  origin: "remote" | "local" | "auto" | "system" | "reading";
  user_id: string | null;
  actor_label: string | null;
  authorship_source?: string | null;
  noise_reason?: string | null;
}

export interface Criterion {
  criterio: string;
  violacoes: number;
  passou: boolean;
}

const TECHNICAL_LABEL = /(telemetria|rf|agent|bridge|sistema tsnn|desconhecid)/i;

export const CRITERIA = [
  "remoto sem usuário",
  "rótulo provisório como usuário",
  "remoto sem fonte auditável",
] as const;

export function auditAcceptance(events: AuditEvent[]): Criterion[] {
  const usable = events.filter((e) => !e.noise_reason);
  const remotes = usable.filter((e) => e.origin === "remote");

  const counts: Record<string, number> = {
    "remoto sem usuário": remotes.filter((e) => !e.user_id).length,
    "rótulo provisório como usuário": usable.filter(
      (e) => !e.user_id && !!e.actor_label && TECHNICAL_LABEL.test(e.actor_label),
    ).length,
    "remoto sem fonte auditável": remotes.filter((e) => !e.authorship_source).length,
  };

  // Um item por critério — a lista de critérios é a fonte única da verdade.
  return CRITERIA.map((criterio) => ({
    criterio,
    violacoes: counts[criterio] ?? 0,
    passou: (counts[criterio] ?? 0) === 0,
  }));
}

export interface FarmCount {
  farm_id: string;
  farm_name: string;
  eventos: number;
  remotos_sem_nome: number;
}

/** Todas as fazendas aparecem no placar — sem eventos ⇒ zero, nunca omitida. */
export function farmScoreboard(
  farms: Array<{ id: string; name: string }>,
  events: AuditEvent[],
): FarmCount[] {
  return farms.map((f) => {
    const own = events.filter((e) => e.farm_id === f.id && !e.noise_reason);
    return {
      farm_id: f.id,
      farm_name: f.name,
      eventos: own.length,
      remotos_sem_nome: own.filter((e) => e.origin === "remote" && !e.user_id).length,
    };
  });
}
