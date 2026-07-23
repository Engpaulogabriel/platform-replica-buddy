// Aba "Indicadores Gerenciais" — visão consolidada com:
//  • Cards síntese: Eficiência Energética (24h), Score, ROI 30d
//  • Histórico de Produtividade (volume, horas, acionamentos, eficiência)
//  • ROI Histórico (linha acumulada + barras mensais + tabela)
// Todos os históricos têm seletor de período (default 30d, com botão "Desde
// o início") e filtro por equipamento, e leem dados reais do banco.
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BarChart3 } from "lucide-react";
import { EnergyEfficiencyCard } from "@/components/dashboard/EnergyEfficiencyCard";
import { EnergyEfficiencyHistoryPanel, defaultHistRange, type HistRange } from "@/components/indicadores/EnergyEfficiencyHistoryPanel";
import { FarmScoreCard } from "@/components/dashboard/FarmScoreCard";
import { RoiTravelCard } from "@/components/dashboard/RoiTravelCard";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { useFarmAccess } from "@/hooks/useFarmAccess";
import { useMasterManager } from "@/contexts/MasterManagerContext";
import { PeriodPicker, defaultPeriodRange } from "@/components/indicadores/PeriodPicker";
import { ProductivityCharts } from "@/components/indicadores/ProductivityCharts";
import { RoiHistoryPanel } from "@/components/indicadores/RoiHistoryPanel";
import { useProductivityHistory } from "@/hooks/useProductivityHistory";
import { useRoiHistory } from "@/hooks/useRoiHistory";
import { RoiProjectionPanel } from "@/components/indicadores/RoiProjectionPanel";
import { ManualVsAutoPanel } from "@/components/indicadores/ManualVsAutoPanel";

export default function Indicadores() {
  const farmId = useDefaultFarmId();
  const { canViewFinancial } = useFarmAccess();
  const { isMasterManager, permissions } = useMasterManager();
  const navigate = useNavigate();

  useEffect(() => {
    if (isMasterManager && !permissions.can_view_indicators) {
      if (permissions.can_view_dashboard) navigate("/home", { replace: true });
      else if (permissions.can_view_reports) navigate("/relatorios", { replace: true });
      else navigate("/manutencao", { replace: true });
    }
  }, [isMasterManager, permissions, navigate]);

  const [range, setRange] = useState(defaultPeriodRange);
  const [pumpFilter, setPumpFilter] = useState<string>("all");
  const [effHistRange, setEffHistRange] = useState<HistRange>(defaultHistRange);

  const productivity = useProductivityHistory(farmId, range, pumpFilter);
  const roiHist = useRoiHistory(farmId, range);

  const pumps = useMemo(() => productivity.pumps, [productivity.pumps]);

  // Label do 2º hero box do EnergyEfficiencyCard, alinhado ao seletor do histórico
  const heroCustomPeriod = useMemo(() => {
    const label =
      effHistRange.quick === 7 ? "Últimos 7 dias"
      : effHistRange.quick === 30 ? "Últimos 30 dias"
      : effHistRange.quick === 60 ? "Últimos 60 dias"
      : effHistRange.quick === 90 ? "Últimos 90 dias"
      : "Período selecionado";
    return { startDate: effHistRange.startDate, endDate: effHistRange.endDate, label };
  }, [effHistRange]);

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-[1600px] mx-auto">
      <header className="flex items-start gap-3 mb-2">
        <div className="p-2.5 rounded-xl bg-primary/15 border border-primary/30">
          <BarChart3 className="w-6 h-6 text-primary" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-foreground leading-tight">Indicadores Gerenciais</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Eficiência energética, score operacional, produtividade histórica{canViewFinancial ? " e retorno sobre investimento." : "."}
          </p>
        </div>
      </header>

      {/* Cards síntese (estado em tempo real) */}
      <EnergyEfficiencyCard farmId={farmId} customPeriod={heroCustomPeriod} />
      <EnergyEfficiencyHistoryPanel farmId={farmId} range={effHistRange} onRangeChange={setEffHistRange} />
      <div className={`grid grid-cols-1 ${canViewFinancial ? "md:grid-cols-2" : ""} gap-4`}>
        <FarmScoreCard farmId={farmId} />
        {canViewFinancial && <RoiTravelCard farmId={farmId} />}
      </div>

      {/* Histórico — controles compartilhados */}
      <div className="pt-2">
        <PeriodPicker
          farmId={farmId}
          value={range}
          onChange={setRange}
          pumpFilter={pumpFilter}
          onPumpChange={setPumpFilter}
          pumps={pumps}
        />
      </div>

      <ProductivityCharts history={productivity} />

      <ManualVsAutoPanel farmId={farmId} history={productivity} />

      {canViewFinancial && <RoiProjectionPanel roi={roiHist} productivity={productivity} />}

      {canViewFinancial && <RoiHistoryPanel history={roiHist} />}
    </div>
  );
}
