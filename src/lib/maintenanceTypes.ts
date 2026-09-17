// Tipos de problema das ordens de manutenção (tabela public.maintenance_orders).
export const PROBLEM_TYPES: Record<string, string> = {
  eletrico: "Elétrico",
  mecanico: "Mecânico",
  hidraulico: "Hidráulico",
  radio: "Rádio / Comunicação",
  painel: "Painel / Quadro",
  sensor: "Sensor",
  bomba: "Bomba",
  motor: "Motor",
  outro: "Outro",
};

export function problemLabel(type?: string | null): string {
  if (!type) return "Não especificado";
  return PROBLEM_TYPES[type] ?? type;
}

export const PRIORITY_LABELS: Record<string, string> = {
  alta: "Alta",
  media: "Média",
  baixa: "Baixa",
};

export function priorityLabel(p?: string | null): string {
  if (!p) return "—";
  return PRIORITY_LABELS[p] ?? p;
}
