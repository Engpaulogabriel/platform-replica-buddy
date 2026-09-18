import { useEffect, useState, useCallback } from "react";
import {
  tryGetSupabaseForFarm,
  assertOperationalClient,
  backendLabelForFarm,
  type RenovSupabase,
} from "@/lib/supabaseRouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { toast } from "@/hooks/use-toast";
import { usePlatformAccess } from "@/hooks/usePlatformAccess";
import { useUserFarms } from "@/hooks/useUserFarms";
import { Power, Loader2 } from "lucide-react";

interface Counts {
  total: number;
  enabled: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Esta tela é FARM-SCOPED: a flag forced_shutdown_enabled vive em equipments, e
// o Agent a lê do backend para o qual a fazenda foi promovida. Ler ou gravar no
// backend errado faz a tela afirmar "Ativo" enquanto o Agent enxerga false — a
// bomba em modo LOCAL deixa de ser desligável e ninguém percebe.
//
// Por isso: cliente resolvido UMA VEZ por operação, a partir do farm_id da
// própria operação, e capturado até o fim do fluxo. Sem fallback silencioso
// para o backend antigo — indisponível mostra indisponível.
// ─────────────────────────────────────────────────────────────────────────────

const ForcedShutdownAdmin = () => {
  const { isAdmin, loading: roleLoading } = usePlatformAccess();
  const { farms, activeFarmId, loading: farmsLoading } = useUserFarms();
  const [selectedFarm, setSelectedFarm] = useState<string | null>(null);
  const [counts, setCounts] = useState<Counts>({ total: 0, enabled: 0 });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Motivo de indisponibilidade do backend da fazenda. Nunca mostrar número junto. */
  const [unavailable, setUnavailable] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedFarm && activeFarmId) setSelectedFarm(activeFarmId);
  }, [activeFarmId, selectedFarm]);

  /**
   * `client` opcional: quando vem do toggle, é o MESMO objeto que executou o
   * UPDATE — garante que a releitura confirme a gravação no backend em que ela
   * de fato ocorreu, e não em outro.
   */
  const load = useCallback(async (farmId: string, client?: RenovSupabase) => {
    setLoading(true);
    try {
      const db = client ?? (() => {
        const r = tryGetSupabaseForFarm(farmId);
        if (!r.client) throw new Error("reason" in r ? r.reason : "Backend indisponível.");
        return r.client;
      })();
      const { data, error } = await db
        .from("equipments")
        .select("id, forced_shutdown_enabled")
        .eq("farm_id", farmId);
      if (error) throw error;
      const total = data?.length ?? 0;
      const enabled = (data ?? []).filter((e: any) => e.forced_shutdown_enabled).length;
      setCounts({ total, enabled });
      setUnavailable(null);
    } catch (e: any) {
      // Fail-visible: zera a contagem para não exibir número de leitura anterior
      // (possivelmente de outra fazenda) como se fosse o estado desta.
      setCounts({ total: 0, enabled: 0 });
      setUnavailable(e.message);
      toast({ title: "Erro ao carregar equipamentos", description: e.message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedFarm) void load(selectedFarm);
  }, [selectedFarm, load]);

  const allOn = counts.total > 0 && counts.enabled === counts.total;

  const handleToggle = async (checked: boolean) => {
    if (!selectedFarm) return;
    setSaving(true);
    try {
      // FAIL-CLOSED. Fazenda migrada sem sessão no backend novo lança aqui e
      // NUNCA cai para o antigo: é preferível recusar a gravar onde o Agent
      // daquela fazenda não lê.
      const farmId = selectedFarm;
      const db = assertOperationalClient(farmId);
      const { error } = await db
        .from("equipments")
        .update({ forced_shutdown_enabled: checked })
        .eq("farm_id", farmId);
      if (error) throw error;
      toast({
        title: checked ? "Desligamento forçado ativado" : "Desligamento forçado desativado",
        description: `Aplicado a todas as bombas da fazenda selecionada (servidor ${backendLabelForFarm(farmId)}).`,
      });
      await load(farmId, db);
    } catch (e: any) {
      toast({ title: "Erro ao atualizar", description: e.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  if (roleLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" /> Verificando permissões…
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <Card className="bg-card border-border">
        <CardContent className="p-6 text-sm text-muted-foreground">
          Apenas administradores da plataforma podem alterar esta configuração.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Power className="w-5 h-5 text-primary" />
          Desligamento Forçado
        </CardTitle>
        <p className="text-sm text-muted-foreground pt-1">
          Quando ativo, permite desligar remotamente bombas que foram ligadas pela botoeira local
          (modo LOCAL). Quando desativado, o comando de desligar segue o fluxo normal.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Fazenda</Label>
          <Select
            value={selectedFarm ?? undefined}
            onValueChange={(v) => setSelectedFarm(v)}
            disabled={farmsLoading || farms.length === 0}
          >
            <SelectTrigger className="w-full max-w-md">
              <SelectValue placeholder="Selecione uma fazenda" />
            </SelectTrigger>
            <SelectContent>
              {farms.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}
                  {f.city ? ` — ${f.city}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {selectedFarm && (
          <div className="flex items-center justify-between rounded-lg border border-border bg-secondary/40 p-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">Estado atual</span>
                {loading ? (
                  <Badge variant="outline" className="gap-1">
                    <Loader2 className="w-3 h-3 animate-spin" /> carregando
                  </Badge>
                ) : unavailable ? (
                  <Badge variant="outline" className="border-destructive text-destructive">
                    indisponível
                  </Badge>
                ) : allOn ? (
                  <Badge className="bg-emerald-600 hover:bg-emerald-600 text-white">Ativo</Badge>
                ) : counts.enabled > 0 ? (
                  <Badge variant="outline" className="border-amber-500 text-amber-600">
                    Parcial
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-muted-foreground">Desativado</Badge>
                )}
              </div>
              {unavailable ? (
                <p className="text-xs text-destructive">{unavailable}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {counts.enabled} de {counts.total} bomba(s) com a flag ativa nesta fazenda.
                </p>
              )}
            </div>

            <div className="flex items-center gap-3">
              {saving && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />}
              <Switch
                checked={allOn}
                onCheckedChange={handleToggle}
                disabled={saving || loading || counts.total === 0}
                aria-label="Alternar desligamento forçado"
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
};

export default ForcedShutdownAdmin;
