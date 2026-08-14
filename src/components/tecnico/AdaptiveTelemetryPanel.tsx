// Setor Técnico → Comunicação Assistida por Poço.
// ---------------------------------------------------------------------------
// Único lugar onde a função existe para o olho humano. Restrito a
// platform_admin e platform_support. Não aparece em PumpCard, dashboard comum,
// nem para cliente, owner, gestor, operador ou viewer.
//
// A função é OPT-IN por poço e nasce DESLIGADA. Ligar aqui muda apenas a
// PRIORIDADE DE LEITURA daquele poço — nunca aciona relé, nunca altera a regra
// de Offline de 15 minutos e nunca gera evento no Relatório de Automação.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCanViewTechnicalTelemetry } from "@/hooks/useTechnicalTelemetry";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { Switch } from "@/components/ui/switch";
import { Radar } from "lucide-react";
import { notify } from "@/lib/notify";

interface Row {
  equipment_id: string;
  equipamento: string;
  assistida: boolean;
  minutos_sem_resposta: number | null;
  estado: string;
  falhas_consecutivas: number;
  retries_24h: number;
  max_sem_resposta_24h_min: number | null;
  alterado_em: string | null;
  alterado_por: string | null;
}

const CORES: Record<string, string> = {
  "Normal":      "text-muted-foreground",
  "Atenção":     "text-warning",
  "Recuperação": "text-warning",
  "Crítico":     "text-destructive",
  "Offline":     "text-destructive font-semibold",
};

export function AdaptiveTelemetryPanel() {
  const canSee = useCanViewTechnicalTelemetry();
  const farmId = useDefaultFarmId();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!farmId) { setRows([]); setLoading(false); return; }
    setLoading(true);
    const { data, error } = await supabase.rpc("adaptive_telemetry_health", { _farm_id: farmId });
    if (error) notify.fail("Comunicação assistida", "não foi possível carregar");
    setRows((data as Row[]) ?? []);
    setLoading(false);
  }, [farmId]);

  useEffect(() => { if (canSee) void load(); }, [canSee, load]);

  // Fecha a porta também no cliente: sem permissão, a tela nem monta.
  if (!canSee) return null;

  const toggle = async (row: Row, next: boolean) => {
    setSaving(row.equipment_id);
    const { error } = await supabase.rpc("set_adaptive_telemetry", {
      _equipment_id: row.equipment_id, _enabled: next, _profile: "conservador",
    });
    setSaving(null);
    if (error) { notify.fail("Comunicação assistida", `não foi possível alterar ${row.equipamento}`); return; }
    notify.ok("Comunicação assistida", `${next ? "ativada" : "desativada"} em ${row.equipamento}`);
    void load();
  };

  return (
    <div data-testid="adaptive-telemetry-panel" className="space-y-3">
      <div className="flex items-start gap-2 rounded-md border border-border bg-secondary/40 p-3">
        <Radar className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
        <div className="text-xs text-muted-foreground">
          <p className="font-semibold text-foreground">Comunicação Assistida — por poço</p>
          <p>
            Desligada por padrão. Quando ativada, o agente encaixa tentativas extras
            de <strong>leitura</strong> entre as leituras normais, conforme o tempo sem
            resposta física do poço. Nunca aciona a bomba, nunca atrasa os demais poços
            e nunca altera a regra de Offline de 15 minutos. Teto de 20% das
            transmissões da rodada.
          </p>
        </div>
      </div>

      {loading ? (
        <p className="text-xs text-muted-foreground">Carregando…</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">Nenhum poço ativo nesta fazenda.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-left text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Poço</th>
                <th className="py-2 pr-3 font-medium">Assistida</th>
                <th className="py-2 pr-3 font-medium">Estado</th>
                <th className="py-2 pr-3 font-medium">Sem resposta</th>
                <th className="py-2 pr-3 font-medium">Falhas</th>
                <th className="py-2 pr-3 font-medium">Retries 24h</th>
                <th className="py-2 pr-3 font-medium">Máx. 24h</th>
                <th className="py-2 font-medium">Última alteração</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.equipment_id} data-testid={`at-row-${r.equipment_id}`}
                    className="border-b border-border/50">
                  <td className="py-2 pr-3 font-medium text-foreground">{r.equipamento}</td>
                  <td className="py-2 pr-3">
                    <Switch
                      checked={r.assistida}
                      disabled={saving === r.equipment_id}
                      onCheckedChange={(v) => toggle(r, v)}
                      aria-label={`Comunicação assistida em ${r.equipamento}`}
                    />
                  </td>
                  <td className={`py-2 pr-3 ${CORES[r.estado] ?? "text-muted-foreground"}`}>{r.estado}</td>
                  <td className="py-2 pr-3 tabular-nums">
                    {r.minutos_sem_resposta != null ? `${r.minutos_sem_resposta} min` : "—"}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{r.falhas_consecutivas ?? 0}</td>
                  <td className="py-2 pr-3 tabular-nums">{r.retries_24h ?? 0}</td>
                  <td className="py-2 pr-3 tabular-nums">
                    {r.max_sem_resposta_24h_min != null ? `${r.max_sem_resposta_24h_min} min` : "—"}
                  </td>
                  <td className="py-2 text-muted-foreground">
                    {r.alterado_em
                      ? `${new Date(r.alterado_em).toLocaleString("pt-BR")}${r.alterado_por ? ` — ${r.alterado_por}` : ""}`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default AdaptiveTelemetryPanel;
