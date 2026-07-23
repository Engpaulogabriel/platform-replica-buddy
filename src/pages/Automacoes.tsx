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

  // Load history of last 30 executions for this farm
  useEffect(() => {
    if (!activeFarmId || items.length === 0) {
      setHistory([]);
      return;
    }
    void (async () => {
      const ids = items.map((a) => a.id);
      const { data } = await supabase
        .from("automation_execution_history")
        .select("*")
        .in("automation_id", ids)
        .order("triggered_at", { ascending: false })
        .limit(30);
      setHistory(data ?? []);
    })();
  }, [activeFarmId, items]);

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




      {/* Active */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Automações Ativas ({active.length})
        </h2>
        {loading ? (
          <p className="text-sm text-muted-foreground">Carregando…</p>
        ) : active.length === 0 ? (
          <Card className="p-8 text-center text-sm text-muted-foreground">
            Nenhuma automação ativa. Clique em "Nova Automação" para criar a primeira.
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
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
        )}
      </section>

      {/* Inactive */}
      {inactive.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
            Inativas ({inactive.length})
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 opacity-70">
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
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
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
                {history.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="text-center px-3 py-6 text-muted-foreground">
                      Nenhuma execução registrada ainda.
                    </td>
                  </tr>
                ) : (
                  history.map((h) => {
                    const acts: any[] = Array.isArray(h.actions_executed) ? h.actions_executed : [];
                    return (
                      <tr key={h.id} className="border-t">
                        <td className="px-3 py-2 whitespace-nowrap">
                          {new Date(h.triggered_at).toLocaleString("pt-BR")}
                        </td>
                        <td className="px-3 py-2">{automacaoNameById.get(h.automation_id) ?? "—"}</td>
                        <td className="px-3 py-2">{acts.length} equip.</td>
                        <td className="px-3 py-2">
                          {h.all_success ? (
                            <span className="text-emerald-600">✅ Sucesso</span>
                          ) : (
                            <span className="text-amber-600">⚠️ Parcial</span>
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
