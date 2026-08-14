// Setor Técnico → Proteções por Poço.
// ---------------------------------------------------------------------------
// Único lugar onde a Proteção de Comutação existe para o olho humano. Restrito
// a platform_admin e a técnicos cadastrados em platform_support — o cliente
// nunca vê esta tela nem sabe que a função existe.
//
// A proteção é OPT-IN por poço e nasce DESLIGADA. Ligar aqui faz o servidor
// recusar novo comando naquele poço durante a janela, após uma confirmação
// física. Desligar volta ao comportamento normal na hora.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCanViewTechnicalTelemetry } from "@/hooks/useTechnicalTelemetry";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { Switch } from "@/components/ui/switch";
import { ShieldCheck, Lock } from "lucide-react";
import { notify } from "@/lib/notify";

interface Row {
  equipment_id: string;
  equipment_name: string;
  enabled: boolean;
  seconds: number;
  currently_locked: boolean;
  last_change_at: string | null;
  last_change_by: string | null;
}

export function SwitchingProtectionPanel() {
  const canSee = useCanViewTechnicalTelemetry();
  const farmId = useDefaultFarmId();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!farmId) { setRows([]); setLoading(false); return; }
    setLoading(true);
    const { data, error } = await supabase.rpc("switching_protection_list", { _farm_id: farmId });
    if (error) notify.error("Não foi possível carregar as proteções.");
    setRows((data as Row[]) ?? []);
    setLoading(false);
  }, [farmId]);

  useEffect(() => { if (canSee) void load(); }, [canSee, load]);

  // Fecha a porta também no cliente: sem permissão, a tela nem monta.
  if (!canSee) return null;

  const toggle = async (row: Row, next: boolean) => {
    setSaving(row.equipment_id);
    const { error } = await supabase.rpc("set_switching_protection", {
      _equipment_id: row.equipment_id,
      _enabled: next,
      _seconds: row.seconds ?? 30,
    });
    setSaving(null);
    if (error) { notify.error("Não foi possível alterar a proteção deste poço."); return; }
    notify.success(next
      ? `Proteção ativada em ${row.equipment_name}.`
      : `Proteção desativada em ${row.equipment_name}.`);
    void load();
  };

  const setSeconds = async (row: Row, secs: number) => {
    if (!Number.isFinite(secs) || secs < 1 || secs > 600) {
      notify.error("Use um valor entre 1 e 600 segundos."); return;
    }
    setSaving(row.equipment_id);
    const { error } = await supabase.rpc("set_switching_protection", {
      _equipment_id: row.equipment_id, _enabled: row.enabled, _seconds: secs,
    });
    setSaving(null);
    if (error) { notify.error("Não foi possível alterar a janela."); return; }
    void load();
  };

  return (
    <div data-testid="switching-protection-panel" className="space-y-3">
      <div className="flex items-start gap-2 rounded-md border border-border bg-secondary/40 p-3">
        <ShieldCheck className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground" />
        <div className="text-xs text-muted-foreground">
          <p className="font-semibold text-foreground">Proteção de Comutação — por poço</p>
          <p>
            Desligada por padrão. Quando ativada, o servidor recusa um novo comando
            naquele poço durante a janela, contada a partir da confirmação física da
            mudança de estado. Não aparece no dashboard do cliente e não gera evento
            no Relatório de Automação — as recusas ficam na auditoria técnica.
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
                <th className="py-2 pr-3 font-medium">Proteção</th>
                <th className="py-2 pr-3 font-medium">Janela (s)</th>
                <th className="py-2 pr-3 font-medium">Agora</th>
                <th className="py-2 font-medium">Última alteração</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.equipment_id} data-testid={`sp-row-${r.equipment_id}`}
                    className="border-b border-border/50">
                  <td className="py-2 pr-3 font-medium text-foreground">{r.equipment_name}</td>
                  <td className="py-2 pr-3">
                    <Switch
                      checked={r.enabled}
                      disabled={saving === r.equipment_id}
                      onCheckedChange={(v) => toggle(r, v)}
                      aria-label={`Proteção de comutação em ${r.equipment_name}`}
                    />
                  </td>
                  <td className="py-2 pr-3">
                    <input
                      type="number" min={1} max={600}
                      defaultValue={r.seconds ?? 30}
                      disabled={!r.enabled || saving === r.equipment_id}
                      onBlur={(e) => {
                        const v = Number(e.currentTarget.value);
                        if (v !== r.seconds) void setSeconds(r, v);
                      }}
                      className="w-16 rounded border border-border bg-background px-1 py-0.5 tabular-nums disabled:opacity-50"
                    />
                  </td>
                  <td className="py-2 pr-3">
                    {r.currently_locked ? (
                      <span className="inline-flex items-center gap-1 text-warning">
                        <Lock className="w-3 h-3" /> em proteção
                      </span>
                    ) : (
                      <span className="text-muted-foreground">livre</span>
                    )}
                  </td>
                  <td className="py-2 text-muted-foreground">
                    {r.last_change_at
                      ? `${new Date(r.last_change_at).toLocaleString("pt-BR")}${r.last_change_by ? ` — ${r.last_change_by}` : ""}`
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

export default SwitchingProtectionPanel;
