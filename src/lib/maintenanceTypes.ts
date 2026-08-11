// Setor Técnico — tipos/labels compartilhados (aba + card do dashboard).
export type MaintenancePriority = "alta" | "media" | "baixa";
export type MaintenanceStatus = "aberto" | "em_andamento" | "concluido";

export interface MaintenanceOrder {
  id: string;
  farm_id: string;
  equipment_id: string | null;
  equipment_name: string | null;
  problem_type: string;
  description: string | null;
  priority: MaintenancePriority;
  status: MaintenanceStatus;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  completed_by: string | null;
  notes: string | null;
}

export const PROBLEM_TYPES: Array<{ value: string; label: string }> = [
  { value: "nivel_zerado", label: "Nível zerado" },
  { value: "sensor_defeito", label: "Sensor com defeito" },
  { value: "bomba_ruido", label: "Bomba com ruído" },
  { value: "sem_comunicacao", label: "Sem comunicação" },
  { value: "vazamento", label: "Vazamento" },
  { value: "preventiva", label: "Manutenção preventiva" },
  { value: "outro", label: "Outro" },
];

export const PROBLEM_LABEL: Record<string, string> = Object.fromEntries(
  PROBLEM_TYPES.map((p) => [p.value, p.label]),
);

export const PRIORITY_LABEL: Record<MaintenancePriority, string> = {
  alta: "Alta",
  media: "Média",
  baixa: "Baixa",
};

export const STATUS_LABEL: Record<MaintenanceStatus, string> = {
  aberto: "Aberto",
  em_andamento: "Em andamento",
  concluido: "Concluído",
};

// Nível zerado = prioridade ALTA por padrão (o sensor pode estar com defeito).
export function defaultPriorityFor(problemType: string): MaintenancePriority {
  if (problemType === "nivel_zerado") return "alta";
  if (problemType === "sem_comunicacao" || problemType === "vazamento") return "alta";
  return "media";
}

export function problemLabel(t: string): string {
  return PROBLEM_LABEL[t] ?? t;
}
