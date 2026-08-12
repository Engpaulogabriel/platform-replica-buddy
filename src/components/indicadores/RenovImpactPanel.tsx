// Painel de Impacto RENOV — mostra a economia MEDIDA (defensável, dados reais)
// em destaque e, separado, o IMPACTO ESTIMADO por premissa (cada card diz a
// premissa). Dinâmico por fazenda. Ver useRenovImpact.
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, Truck, Zap, Droplets, ShieldAlert, Users, Wrench, Info } from "lucide-react";
import { useRenovImpact, IMPACT_PREMISES } from "@/hooks/useRenovImpact";

const fmtBRL = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const fmtNum = (v: number, dec = 0) => v.toLocaleString("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: dec });

export function RenovImpactPanel({ farmId }: { farmId: string | null | undefined }) {
  const im = useRenovImpact(farmId);

  if (im.loading) {
    return <Card className="bg-card border-border"><CardContent className="py-8 text-center text-sm text-muted-foreground">Calculando impacto…</CardContent></Card>;
  }
  if (im.insufficientData) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          <Info className="w-6 h-6 mx-auto mb-2 opacity-60" />
          Dados insuficientes — mínimo 30 dias de operação{im.wellCount > 0 ? ` (fazenda tem ${im.daysOfData} dia(s) de histórico)` : ""}.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── MEDIDO (headline defensável) ── */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-emerald-500" /> Economia medida do RENOV — últimos 30 dias
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Só dados reais (deslocamento por geolocalização + energia por tarifa real). {im.wellCount} poços · {Math.round(im.remoteRatio * 100)}% dos acionamentos remotos.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-3">
            <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Economia medida / mês</div>
            <div className="text-2xl font-bold text-emerald-500 tabular-nums">{fmtBRL(im.measuredTotal)}</div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Metric icon={<Truck className="w-4 h-4 text-primary" />} title="Deslocamento evitado" value={fmtBRL(im.deslocamento)}
              hint={`${fmtNum(im.deslocamentoKm)} km/mês · ${fmtNum(im.deslocamentoHoras, 1)} h economizadas (${IMPACT_PREMISES.costPerKm.toLocaleString("pt-BR")} R$/km)`} />
            <Metric icon={<Zap className="w-4 h-4 text-amber-500" />} title="Energia — ponta evitada" value={im.energia > 0 ? fmtBRL(im.energia) : "Dados insuficientes"}
              hint={im.energia > 0 ? `${fmtNum(im.energiaHoras, 1)} h de ponta evitadas × potência real × Δtarifa` : "Sem desligamentos remotos na janela de ponta no período"} />
          </div>
        </CardContent>
      </Card>

      {/* ── ESTIMADO (premissas) ── */}
      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Info className="w-4 h-4 text-info" /> Impacto estimado (premissas conservadoras)
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Baseado em contagens reais × premissas de negócio — NÃO é economia comprovada. Não entra no total medido acima.
          </p>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Metric icon={<Droplets className="w-4 h-4 text-info" />} title="m³ extras irrigados"
            value={`${fmtNum(im.m3Extra)} m³/mês`}
            sub={im.m3ExtraValue != null ? fmtBRL(im.m3ExtraValue) : "requer valor da safra (R$/m³)"}
            premise="Resposta remota real (commands) vs deslocamento manual (dist÷15 km/h). × valor da safra." />
          <Metric icon={<ShieldAlert className="w-4 h-4 text-destructive" />} title="Multas INEMA evitadas"
            value={fmtBRL(im.multasEvitadas)}
            sub={`${im.multasOcorrencias} ocorrência(s) de desligamento preventivo`}
            premise={`Premissa: R$ ${fmtNum(IMPACT_PREMISES.fineValue)}/ocorrência evitada (conservador).`} />
          <Metric icon={<Users className="w-4 h-4 text-primary" />} title="Redução de pessoal"
            value={`${im.pessoalReduzidos} operador(es)`}
            sub={im.pessoalValue != null ? fmtBRL(im.pessoalValue) : "requer salário médio regional"}
            premise={`Antes: 1 operador / ${IMPACT_PREMISES.wellsPerOperator} poços; depois: 1 remoto. × salário.`} />
          <Metric icon={<Wrench className="w-4 h-4 text-amber-500" />} title="Manutenção preventiva"
            value={`${im.manutencaoDetec} bomba(s) em desgaste alto`}
            sub={im.manutencaoDetec > 0 ? `até ${fmtBRL(im.manutencaoValue)} potencial` : "nenhuma detecção no período"}
            premise={`Premissa: R$ ${fmtNum(IMPACT_PREMISES.pumpReplaceCost)}/bomba (troca submersível), detecção precoce.`} />
        </CardContent>
      </Card>
    </div>
  );
}

function Metric({ icon, title, value, hint, sub, premise }: {
  icon: React.ReactNode; title: string; value: string; hint?: string; sub?: string; premise?: string;
}) {
  return (
    <div className="rounded-md border border-border p-3 space-y-1">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">{icon}{title}</div>
      <div className="text-lg font-bold tabular-nums text-foreground">{value}</div>
      {sub && <div className="text-xs text-primary font-medium">{sub}</div>}
      {hint && <div className="text-[11px] text-muted-foreground leading-tight">{hint}</div>}
      {premise && <div className="text-[10px] text-muted-foreground/70 leading-tight flex items-start gap-1 pt-0.5 border-t border-border/50"><Badge variant="outline" className="text-[8px] px-1 py-0 h-3.5 shrink-0">premissa</Badge>{premise}</div>}
    </div>
  );
}

export default RenovImpactPanel;
