// LevelCalibrationCard — UI compartilhada para calibrar nível com 1 ponto.
// Aparece em: Cadastros (editar equipamento tipo nivel) e Diagnóstico (seção Nível).
//
// Modelo de calibração (regra de três simples):
//   - cal_digital  = valor digital de referência (ex: 1008)
//   - cal_meters   = metros correspondentes ao valor digital (ex: 1.61)
//   - max_meters   = nível máximo do reservatório (representa 100%)
//
//   metros_atual  = (raw / cal_digital) * cal_meters
//   porcentagem   = (metros_atual / max_meters) * 100
//
// Botão "Capturar leitura atual" cola o level_last_raw em cal_digital.

import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Activity, Crosshair, Save, Waves } from "lucide-react";
import { notify } from "@/lib/notify";
import { supabase } from "@/integrations/supabase/client";
import { calibrateLevel, formatLevelDisplay } from "@/lib/levelCalibration";
import type { CloudEquipamento } from "@/hooks/useCadastrosCloud";

interface Props {
  equip: CloudEquipamento;
  onSaved?: () => void;
  /** Se true, mostra título compacto sem card wrapper (uso em formulários). */
  compact?: boolean;
}

const numStr = (v: number | null | undefined) =>
  v === null || v === undefined || !Number.isFinite(v) ? "" : String(v);

export default function LevelCalibrationCard({ equip, onSaved, compact }: Props) {
  const [calDigital, setCalDigital] = useState(numStr(equip.level_cal_digital));
  const [calMeters, setCalMeters] = useState(numStr(equip.level_cal_meters));
  const [maxMeters, setMaxMeters] = useState(numStr(equip.level_max_meters));
  const [saving, setSaving] = useState(false);

  // Sincroniza quando o equip muda (Realtime)
  useEffect(() => {
    setCalDigital(numStr(equip.level_cal_digital));
    setCalMeters(numStr(equip.level_cal_meters));
    setMaxMeters(numStr(equip.level_max_meters));
  }, [
    equip.id,
    equip.level_cal_digital,
    equip.level_cal_meters,
    equip.level_max_meters,
  ]);

  const lastRaw = equip.level_last_raw ?? null;
  const lastRawAt = equip.level_last_raw_at ? new Date(equip.level_last_raw_at) : null;
  const sensorIndex = equip.level_sensor_index ?? null;

  const preview = useMemo(
    () => calibrateLevel({
      raw: lastRaw,
      cal_digital: calDigital === "" ? null : Number(calDigital),
      cal_meters: calMeters === "" ? null : Number(calMeters),
      max_meters: maxMeters === "" ? null : Number(maxMeters),
      max_height: equip.max_height,
    }),
    [lastRaw, calDigital, calMeters, maxMeters, equip.max_height],
  );

  const captureRaw = () => {
    if (lastRaw === null) {
      notify.fail("Calibração de Nível", "Nenhuma leitura recebida ainda.");
      return;
    }
    setCalDigital(String(lastRaw));
  };

  const save = async () => {
    const d = calDigital === "" ? null : Number(calDigital);
    const m = calMeters === "" ? null : Number(calMeters);
    const mx = maxMeters === "" ? null : Number(maxMeters);

    if ([d, m, mx].some((v) => v !== null && !Number.isFinite(v as number))) {
      notify.fail("Calibração de Nível", "Valores inválidos.");
      return;
    }
    if (d !== null && d <= 0) { notify.fail("Calibração de Nível", "O valor digital de referência deve ser maior que zero."); return; }
    if (m !== null && m <= 0) { notify.fail("Calibração de Nível", "Os metros de referência devem ser maiores que zero."); return; }
    if (mx !== null && mx <= 0) { notify.fail("Calibração de Nível", "O nível máximo deve ser maior que zero."); return; }

    setSaving(true);
    const { error } = await supabase
      .from("equipments")
      .update({
        level_cal_digital: d,
        level_cal_meters: m,
        level_max_meters: mx,
      })
      .eq("id", equip.id);
    setSaving(false);

    if (error) { notify.fail("Calibração de Nível", `Erro ao salvar: ${error.message}`); return; }
    notify.ok("Calibração de Nível", "Calibração salva.");
    onSaved?.();
  };

  const liveBlock = (
    <div className="flex items-center justify-between rounded-md border border-border bg-secondary/40 p-3">
      <div className="flex items-center gap-2">
        <Activity className="h-4 w-4 text-primary" />
        <div>
          <div className="text-xs text-muted-foreground">
            Leitura ao vivo {sensorIndex ? `(N${sensorIndex})` : ""}
          </div>
          <div className="text-lg font-semibold tabular-nums">
            {lastRaw !== null ? lastRaw : "—"}
          </div>
        </div>
      </div>
      <div className="text-right">
        <div className="text-xs text-muted-foreground">
          {lastRawAt ? lastRawAt.toLocaleTimeString() : "Sem dados"}
        </div>
        {preview.isCalibrated && (
          <Badge variant="secondary" className="mt-1">
            <Waves className="h-3 w-3 mr-1" />
            {formatLevelDisplay(preview)}
          </Badge>
        )}
      </div>
    </div>
  );

  const formBlock = (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-muted-foreground text-xs">Valor digital de referência</Label>
          <div className="flex gap-1">
            <Input
              type="number"
              value={calDigital}
              onChange={(e) => setCalDigital(e.target.value)}
              placeholder="Ex: 1008"
              className="bg-secondary border-border"
            />
            <Button type="button" variant="outline" size="icon" onClick={captureRaw} title="Capturar leitura atual">
              <Crosshair className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <div>
          <Label className="text-muted-foreground text-xs">Metros correspondentes</Label>
          <Input
            type="number"
            step="0.01"
            value={calMeters}
            onChange={(e) => setCalMeters(e.target.value)}
            placeholder="Ex: 1.61"
            className="bg-secondary border-border"
          />
        </div>
      </div>

      <div>
        <Label className="text-muted-foreground text-xs">Nível máximo do reservatório (= 100%)</Label>
        <Input
          type="number"
          step="0.01"
          value={maxMeters}
          onChange={(e) => setMaxMeters(e.target.value)}
          placeholder="Ex: 5.00"
          className="bg-secondary border-border"
        />
      </div>

      <div className="flex justify-end pt-2">
        <Button type="button" onClick={save} disabled={saving} size="sm">
          <Save className="h-4 w-4 mr-1" />
          {saving ? "Salvando..." : "Salvar calibração"}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Cole a leitura digital atual (botão <Crosshair className="inline h-3 w-3" />) e informe a profundidade real medida.
        O nível máximo define o que será mostrado como 100%. Fórmula: <code>metros = (leitura ÷ digital ref) × metros ref</code>.
      </p>
    </div>
  );

  if (compact) {
    return (
      <div className="space-y-3">
        {liveBlock}
        {formBlock}
      </div>
    );
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Waves className="h-4 w-4 text-primary" />
          Calibração de Nível — {equip.name}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {liveBlock}
        {formBlock}
      </CardContent>
    </Card>
  );
}
