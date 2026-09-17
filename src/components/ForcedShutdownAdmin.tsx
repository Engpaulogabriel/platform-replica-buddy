import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
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

const ForcedShutdownAdmin = () => {
  const { isAdmin, loading: roleLoading } = usePlatformAccess();
  const { farms, activeFarmId, loading: farmsLoading } = useUserFarms();
  const [selectedFarm, setSelectedFarm] = useState<string | null>(null);
  const [counts, setCounts] = useState<Counts>({ total: 0, enabled: 0 });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!selectedFarm && activeFarmId) setSelectedFarm(activeFarmId);
  }, [activeFarmId, selectedFarm]);

  const load = useCallback(async (farmId: string) => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("equipments")
        .select("id, forced_shutdown_enabled")
        .eq("farm_id", farmId);
      if (error) throw error;
      const total = data?.length ?? 0;
      const enabled = (data ?? []).filter((e: any) => e.forced_shutdown_enabled).length;
      setCounts({ total, enabled });
    } catch (e: any) {
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
      const { error } = await supabase
        .from("equipments")
        .update({ forced_shutdown_enabled: checked })
        .eq("farm_id", selectedFarm);
      if (error) throw error;
      toast({
        title: checked ? "Desligamento forçado ativado" : "Desligamento forçado desativado",
        description: `Aplicado a todas as bombas da fazenda selecionada.`,
      });
      await load(selectedFarm);
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
              <p className="text-xs text-muted-foreground">
                {counts.enabled} de {counts.total} bomba(s) com a flag ativa nesta fazenda.
              </p>
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
