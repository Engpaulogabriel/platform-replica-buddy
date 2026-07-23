// NivelSection — Diagnóstico de sensores de nível.
// Lista todos os equipamentos do tipo "nivel" da fazenda, mostra a leitura
// digital N1/N2 ao vivo (via Realtime do useCadastrosCloud) e oferece
// calibração inline via LevelCalibrationCard.

import { useCadastrosCloud } from "@/hooks/useCadastrosCloud";
import { Card, CardContent } from "@/components/ui/card";
import { Activity, Waves } from "lucide-react";
import LevelCalibrationCard from "@/components/LevelCalibrationCard";

export default function NivelSection() {
  const cloud = useCadastrosCloud();
  const niveis = cloud.equipments.filter((e) => e.type === "nivel");

  if (cloud.loading) {
    return <p className="text-sm text-muted-foreground">Carregando equipamentos…</p>;
  }

  if (niveis.length === 0) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="pt-6 flex items-center gap-3 text-muted-foreground">
          <Activity className="h-5 w-5" />
          Nenhum equipamento do tipo Nível cadastrado.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-muted/40 p-4 flex items-start gap-3">
        <Waves className="h-5 w-5 text-primary shrink-0 mt-0.5" />
        <div className="text-sm text-muted-foreground">
          As leituras digitais N1/N2 chegam embutidas em cada frame de telemetria do PLC.
          Calibração por 1 ponto: capture a leitura digital atual e informe a profundidade real medida
          (ex: digital 1008 = 1,61 m). O nível máximo define o que será mostrado como 100%.
          Fórmula: <code>metros = (leitura ÷ digital ref) × metros ref</code>.
        </div>
      </div>

      {niveis.map((eq) => (
        <LevelCalibrationCard key={eq.id} equip={eq} />
      ))}
    </div>
  );
}
