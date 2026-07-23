// Aba "Manutenção" do /platform — só platform_admin.
// Permite ativar/estender/encerrar Modo Manutenção por fazenda.
// Usa RPCs platform_maintenance_activate / platform_maintenance_release.
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Wrench, Play, X, RefreshCw, Clock, AlertTriangle } from "lucide-react";
import { notify } from "@/lib/notify";
import { useFarmMaintenance, formatCountdown } from "@/hooks/useFarmMaintenance";

interface Farm { farm_id: string; name: string; plan: string }

export default function PlatformMaintenance({ isAdmin }: { isAdmin: boolean }) {
  const [farms, setFarms] = useState<Farm[]>([]);
  const [farmId, setFarmId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [minutes, setMinutes] = useState("30");
  const [reason, setReason] = useState("");

  const lock = useFarmMaintenance(farmId || null);

  const loadFarms = async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc("platform_farms_overview" as any);
    if (error) { notify.fail("Manutenção", error.message); setLoading(false); return; }
    const list = ((data as any) ?? []).map((f: any) => ({ farm_id: f.farm_id, name: f.name, plan: f.plan }));
    setFarms(list);
    if (!farmId && list.length) setFarmId(list[0].farm_id);
    setLoading(false);
  };

  useEffect(() => { void loadFarms(); }, []);

  if (!isAdmin) {
    return <Card><CardContent className="p-6 text-center text-muted-foreground">Apenas Platform Admins podem ativar Modo Manutenção.</CardContent></Card>;
  }

  const activate = async () => {
    if (!farmId) return;
    const m = Math.max(5, Math.min(240, Number(minutes) || 30));
    if (lock.active && !confirm(`Manutenção já ativa (resta ${formatCountdown(lock.secondsLeft)}). Renovar para ${m} min?`)) return;
    if (!lock.active && !confirm(`Ativar Modo Manutenção por ${m} min? Polling, automação e comandos da fazenda serão pausados.`)) return;
    setBusy(true);
    const { error } = await supabase.rpc("platform_maintenance_activate" as any, {
      _farm_id: farmId, _minutes: m, _reason: reason.trim() || null,
    });
    setBusy(false);
    if (error) return notify.fail("Manutenção", error.message);
    notify.ok("Manutenção", `Ativada por ${m} min.`);
  };

  const release = async () => {
    if (!farmId || !confirm("Encerrar Modo Manutenção agora?")) return;
    setBusy(true);
    const { error } = await supabase.rpc("platform_maintenance_release" as any, { _farm_id: farmId });
    setBusy(false);
    if (error) return notify.fail("Manutenção", error.message);
    notify.ok("Manutenção", "Encerrada.");
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Wrench className="w-4 h-4" />Modo Manutenção (fazenda)
            </CardTitle>
            <div className="flex gap-2">
              <Select value={farmId} onValueChange={setFarmId}>
                <SelectTrigger className="w-[280px]"><SelectValue placeholder="Selecione a fazenda" /></SelectTrigger>
                <SelectContent>
                  {farms.map(f => <SelectItem key={f.farm_id} value={f.farm_id}>{f.name}</SelectItem>)}
                </SelectContent>
              </Select>
              <Button variant="outline" size="sm" onClick={loadFarms} disabled={loading}>
                <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-start gap-3 p-3 rounded-md border bg-muted/30 mb-4">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div className="text-xs text-muted-foreground space-y-1">
              <div><strong className="text-foreground">O que acontece</strong> ao ativar:</div>
              <ul className="list-disc pl-4 space-y-0.5">
                <li>Polling automático da fazenda <strong>pausa</strong> (sem leitura de bombas/níveis).</li>
                <li>Motor de automação na nuvem <strong>ignora</strong> a fazenda durante a janela.</li>
                <li>Comandos manuais (Ligar/Desligar/Reset) ficam <strong>bloqueados</strong> para todos os usuários.</li>
                <li>Banner laranja aparece para <strong>todos</strong> os usuários da fazenda com countdown.</li>
                <li>Comandos pendentes na fila são <strong>cancelados</strong> automaticamente.</li>
              </ul>
            </div>
          </div>

          {lock.active && (
            <div className="mb-4 p-3 rounded-md border-2 border-amber-500/60 bg-amber-500/10 flex items-center gap-3">
              <Clock className="w-5 h-5 text-amber-600 animate-pulse" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-amber-900 dark:text-amber-200">Manutenção ativa</div>
                {lock.reason && <div className="text-xs text-muted-foreground truncate">Motivo: {lock.reason}</div>}
              </div>
              <Badge variant="outline" className="font-mono font-bold tabular-nums text-base border-amber-500 text-amber-900 dark:text-amber-200">
                {formatCountdown(lock.secondsLeft)}
              </Badge>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
            <div>
              <Label>Duração</Label>
              <Select value={minutes} onValueChange={setMinutes}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="15">15 minutos</SelectItem>
                  <SelectItem value="30">30 minutos (padrão)</SelectItem>
                  <SelectItem value="60">1 hora</SelectItem>
                  <SelectItem value="120">2 horas</SelectItem>
                  <SelectItem value="240">4 horas (máx)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="md:col-span-2">
              <Label>Motivo (opcional, visível ao operador)</Label>
              <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={120}
                placeholder="Ex.: Troca de cabo no PLC 2101" />
            </div>
          </div>

          <div className="flex gap-2 justify-end">
            {lock.active && (
              <Button variant="outline" onClick={release} disabled={busy} className="border-destructive/40 text-destructive hover:bg-destructive/10">
                <X className="w-4 h-4 mr-2" />Encerrar agora
              </Button>
            )}
            <Button onClick={activate} disabled={busy || !farmId} className="bg-amber-600 hover:bg-amber-700 text-white">
              <Play className="w-4 h-4 mr-2" />
              {lock.active ? "Renovar duração" : "Ativar Modo Manutenção"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
