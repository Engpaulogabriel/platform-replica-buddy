// Indicador técnico da saúde do Realtime — SOMENTE platform_admin/owner.
// Diagnóstico puro: nunca altera cor, estado, comando ou funcionamento de
// nenhuma bomba. Serve para o operador técnico saber se a tela está recebendo
// leitura ao vivo, sem precisar apertar F5 para descobrir.
import { Radio, RefreshCw, AlertTriangle } from "lucide-react";
import { useFarmAccess } from "@/hooks/useFarmAccess";

export type RealtimeHealth = "connected" | "reconnecting" | "degraded";

export interface RealtimeHealthBadgeProps {
  health: RealtimeHealth;
  /** Horário da última leitura física aplicada (epoch ms). */
  lastPhysicalReadAt?: number | null;
  /** Força a exibição em teste/storybook, ignorando o papel do usuário. */
  forceVisible?: boolean;
}

const hhmm = (ts?: number | null) =>
  ts ? new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : null;

export function RealtimeHealthBadge({ health, lastPhysicalReadAt, forceVisible }: RealtimeHealthBadgeProps) {
  const { role } = useFarmAccess();
  const canSee = forceVisible || role === "platform_admin" || role === "owner";
  if (!canSee) return null;

  const t = hhmm(lastPhysicalReadAt);

  if (health === "connected") {
    return (
      <span
        data-testid="realtime-health"
        data-health="connected"
        className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"
        title={t ? `Última leitura física recebida às ${t}` : "Aguardando a primeira leitura física"}
      >
        <Radio className="w-3 h-3 text-primary" />
        Tempo real conectado{t ? ` · ${t}` : ""}
      </span>
    );
  }

  if (health === "reconnecting") {
    return (
      <span
        data-testid="realtime-health"
        data-health="reconnecting"
        className="inline-flex items-center gap-1 text-[10px] text-warning"
        title="A assinatura caiu e está sendo restabelecida automaticamente. Os cards continuam mostrando a última leitura confirmada."
      >
        <RefreshCw className="w-3 h-3 animate-spin" />
        Reconectando
      </span>
    );
  }

  return (
    <span
      data-testid="realtime-health"
      data-health="degraded"
      className="inline-flex items-center gap-1 text-[10px] text-warning"
      title="Não foi possível restabelecer a assinatura em tempo real. As tentativas continuam; ao voltar, a tela se atualiza sozinha."
    >
      <AlertTriangle className="w-3 h-3" />
      Dados podem estar atrasados{t ? ` · última leitura ${t}` : ""}
    </span>
  );
}

export default RealtimeHealthBadge;
