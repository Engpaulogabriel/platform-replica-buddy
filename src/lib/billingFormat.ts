// Formatação financeira — módulo PURO, reutilizável por qualquer tela do módulo.
// Centavos são a unidade canônica no banco; a conversão para exibição acontece
// só aqui, para que nenhum componente faça `/100` por conta própria.

export const centsToBRL = (cents: number | null | undefined): string =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" })
    .format((Number(cents ?? 0)) / 100);

/** Compacto para eixo de gráfico e card: "R$ 2,8 mil", "R$ 1,2 mi". */
export const centsToCompactBRL = (cents: number | null | undefined): string => {
  const v = Number(cents ?? 0) / 100;
  const abs = Math.abs(v);
  if (abs >= 1_000_000) return `R$ ${(v / 1_000_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi`;
  if (abs >= 1_000) return `R$ ${(v / 1_000).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mil`;
  return centsToBRL(cents);
};

export const pctBR = (v: number | null | undefined): string =>
  `${Number(v ?? 0).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`;

/** "2026-09" → "set/2026". Sem `new Date("2026-09")`, que varia por timezone. */
export const monthLabel = (ym: string): string => {
  const [a, m] = String(ym ?? "").split("-").map(Number);
  if (!a || !m) return String(ym ?? "");
  const meses = ["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"];
  return `${meses[m - 1] ?? m}/${a}`;
};

/** Data ISO (só o dia) sem deslocar por fuso — o `-03:00` já mordeu este projeto. */
export const dateBR = (iso: string | null | undefined): string => {
  const s = String(iso ?? "").slice(0, 10);
  const [a, m, d] = s.split("-");
  return a && m && d ? `${d}/${m}/${a}` : "—";
};

export const dateTimeBR = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "—"
    : d.toLocaleString("pt-BR", { timeZone: "America/Bahia", day: "2-digit",
        month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

/** Rótulos legíveis dos enums do banco. */
export const BILLING_TYPE_LABEL: Record<string, string> = {
  taxa_acesso_online: "Taxa de acesso online",
  mensalidade_plataforma: "Mensalidade da plataforma",
  manutencao: "Manutenção", servico: "Serviço", personalizado: "Personalizado",
};

export const CHARGE_STATUS_LABEL: Record<string, string> = {
  prevista: "Prevista", aberta: "Aberta", enviada: "Enviada", paga: "Paga",
  paga_parcial: "Paga parcial", vencida: "Vencida", em_negociacao: "Em negociação",
  cancelada: "Cancelada", estornada: "Estornada",
};

/** Classe do badge por status. Vencida é a única em destructive. */
export const CHARGE_STATUS_CLASS: Record<string, string> = {
  paga: "bg-primary/10 text-primary",
  paga_parcial: "bg-info/10 text-info",
  aberta: "bg-secondary text-muted-foreground",
  enviada: "bg-info/10 text-info",
  prevista: "bg-secondary text-muted-foreground",
  vencida: "bg-destructive/10 text-destructive",
  em_negociacao: "bg-warning/15 text-warning",
  cancelada: "bg-secondary text-muted-foreground line-through",
  estornada: "bg-secondary text-muted-foreground line-through",
};
