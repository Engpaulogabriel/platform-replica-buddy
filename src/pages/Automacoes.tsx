import { useEffect, useMemo, useState } from "react";
import { Zap, Plus, History, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { useUserFarms } from "@/hooks/useUserFarms";
import { useAuth } from "@/contexts/AuthContext";
import { useAutomacoes } from "@/hooks/useAutomacoes";
import { AutomacaoCard } from "@/components/automacoes/AutomacaoCard";
import { AutomacaoFormDialog } from "@/components/automacoes/AutomacaoFormDialog";
import { AutomacoesAuditPanel } from "@/components/automacoes/AutomacoesAuditPanel";
import { ScheduledShutdownSection } from "@/components/automacoes/ScheduledShutdownSection";
import { usePermission } from "@/contexts/MasterManagerContext";


interface EquipmentLite { id: string; name: string; }

export default function Automacoes() {
  const { activeFarmId } = useUserFarms();
  const { user } = useAuth();
  const canEditSchedules = usePermission("can_edit_schedules");
  const { items, loading, create, toggleActive, remove } = useAutomacoes(activeFarmId);


  const [equipments, setEquipments] = useState<EquipmentLite[]>([]);
  const [openForm, setOpenForm] = useState(false);
  const [history, setHistory] = useState<any[]>([]);

  useEffect(() => {
    if (!activeFarmId) return;
    void (async () => {
      const { data } = await supabase
        .from("equipments")
        .select("id, name")
        .eq("farm_id", activeFarmId)
        .order("name");
      setEquipments((data ?? []) as EquipmentLite[]);
    })();
  }, [activeFarmId]);

  // Histórico REAL das execuções automáticas (desligamento programado etc.):
  // lê de automation_log onde origin='auto' — o trigger BEFORE INSERT marca
  // origin='auto' e actor_label = nome da regra (ex.: "Desligamento 17h Semear")
  // a partir de equipments.last_changed_by. Cada linha = 1 equipamento; agrupamos
  // por regra + dia na `executionRows` abaixo. (Antes lia automation_execution_history,
  // preenchido só pelo sistema legado `automations`, que fica vazio para a Semear.)
  useEffect(() => {
    if (!activeFarmId) {
      setHistory([]);
      return;
    }
    void (async () => {
      const { data } = await supabase
        .from("automation_log")
        .select("id, equipment_name, action, result, actor_label, occurred_at")
        .eq("farm_id", activeFarmId)
        .eq("origin", "auto")
        .order("occurred_at", { ascending: false })
        .limit(400);
      setHistory(data ?? []);
    })();
  }, [activeFarmId]);

  const equipmentNameById = useMemo(() => {
    const m = new Map<string, string>();
    equipments.forEach((e) => m.set(e.id, e.name));
    return m;
  }, [equipments]);

  const automacaoNameById = useMemo(() => {
    const m = new Map<string, string>();
    items.forEach((a) => m.set(a.id, a.name));
    return m;
  }, [items]);

  const active = items.filter((a) => a.is_active);
  const inactive = items.filter((a) => !a.is_active);

  // Agrupa as linhas do automation_log (1 por equipamento) em 1 execução por
  // regra + dia: mostra quantos equipamentos e o resultado consolidado.
  const executionRows = useMemo(() => {
    const groups = new Map<string, {
      key: string; label: string; firstAt: string; lastAt: string;
      equipamentos: Set<string>; ok: number; fail: number;
    }>();
    for (const r of history) {
      if (!r?.occurred_at) continue;
      const day = new Date(r.occurred_at).toLocaleDateString("pt-BR");
      const label = (r.actor_label && String(r.actor_label).trim()) ? String(r.actor_label).trim() : "Automação";
      const key = `${label}__${day}`;
      let g = groups.get(key);
      if (!g) {
        g = { key, label, firstAt: r.occurred_at, lastAt: r.occurred_at, equipamentos: new Set(), ok: 0, fail: 0 };
        groups.set(key, g);
      }
      if (r.equipment_name) g.equipamentos.add(r.equipment_name);
      if (r.result === "success") g.ok++; else g.fail++;
      if (new Date(r.occurred_at).getTime() > new Date(g.lastAt).getTime()) g.lastAt = r.occurred_at;
      if (new Date(r.occurred_at).getTime() < new Date(g.firstAt).getTime()) g.firstAt = r.occurred_at;
    }
    return Array.from(groups.values()).sort(
      (a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime(),
    );
  }, [history]);

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold flex items-center gap-2">
            <Zap className="w-7 h-7 text-primary" /> Automações
          </h1>
          <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
            Comandos automáticos independentes. Executam sempre que a condição for atendida,
            sem depender do Modo Automático.
          </p>
        </div>
        {canEditSchedules ? (
          <Button onClick={() => setOpenForm(true)}>
            <Plus className="w-4 h-4 mr-1" /> Nova Automação
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground inline-flex items-center gap-1.5 bg-muted px-3 py-1.5 rounded-md">
            <Lock className="w-3.5 h-3.5" /> Somente leitura
          </span>
        )}
      </div>




      {/* Automações Ativas (config-driven, tabela scheduled_automations): o
          desligamento programado (ex.: 17h Semear) aparece aqui como card
          Nome/Horário/Dias/Equipamentos/Status com Editar/Desativar. É o sistema
          que realmente executa hoje — por isso vem primeiro. */}
      <ScheduledShutdownSection
        farmId={activeFarmId}
        equipments={equipments}
        canEdit={canEditSchedules}
      />

      {/* Automações por condição (sistema legado `automations`): só aparecem
          quando existem — não mostramos "Nenhuma automação ativa" enganoso quando
          já há desligamento programado configurado acima. */}
      {active.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Automações por Condição ({active.length})
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {active.map((a) => (
              <AutomacaoCard
                key={a.id}
                automacao={a}
                equipmentNameById={equipmentNameById}
                onToggle={(id, v) => toggleActive(id, v, user?.email ?? null)}
                onDelete={(id) => remove(id, user?.email ?? null)}
              />
            ))}
          </div>
        </section>
      )}

      {/* Inativas */}
      {inactive.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Inativas ({inactive.length})
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 opacity-70">
            {inactive.map((a) => (
              <AutomacaoCard
                key={a.id}
                automacao={a}
                equipmentNameById={equipmentNameById}
                onToggle={(id, v) => toggleActive(id, v, user?.email ?? null)}
                onDelete={(id) => remove(id, user?.email ?? null)}
              />
            ))}
          </div>
        </section>
      )}

      {/* History */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide flex items-center gap-2">
          <History className="w-4 h-4" /> Histórico de Execuções
        </h2>
        <p className="text-[10px] text-muted-foreground mb-1 sm:hidden">← deslize para ver todas as colunas →</p>
        <Card className="overflow-hidden">
          <div className="overflow-x-auto -mx-2 px-2">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="text-left px-3 py-2">Data/Hora</th>
                  <th className="text-left px-3 py-2">Automação</th>
                  <th className="text-left px-3 py-2">Equipamentos</th>
                  <th className="text-left px-3 py-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {executionRows.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="text-center px-3 py-6 text-muted-foreground">
                      Nenhuma execução automática registrada ainda.
                    </td>
                  </tr>
                ) : (
                  executionRows.map((g) => {
                    const total = g.ok + g.fail;
                    return (
                      <tr key={g.key} className="border-t">
                        <td className="px-3 py-2 whitespace-nowrap">
                          {new Date(g.lastAt).toLocaleString("pt-BR")}
                        </td>
                        <td className="px-3 py-2">{g.label}</td>
                        <td className="px-3 py-2">{g.equipamentos.size} equip.</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {g.fail === 0 ? (
                            <span className="text-emerald-600">✅ Sucesso</span>
                          ) : g.ok === 0 ? (
                            <span className="text-rose-600">❌ Falha ({g.fail})</span>
                          ) : (
                            <span className="text-amber-600">⚠️ Parcial ({g.ok}/{total})</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </section>

      {/* Auditoria completa */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Auditoria
        </h2>
        <AutomacoesAuditPanel
          farmId={activeFarmId}
          equipments={equipments}
          automacaoNameById={automacaoNameById}
        />
      </section>



      <AutomacaoFormDialog
        open={openForm}
        onOpenChange={setOpenForm}
        equipments={equipments}
        onSubmit={(input) => create(input, user?.email ?? null)}
      />
    </div>
  );
}
