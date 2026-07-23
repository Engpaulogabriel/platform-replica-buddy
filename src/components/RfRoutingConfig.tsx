import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Radio, Save, RefreshCw } from "lucide-react";
import { notify } from "@/lib/notify";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import {
  loadRfRouting,
  pullRfRoutingFromCloud,
  saveRfRoutingCloud,
  type RfRoutingConfig as RfRoutingCfg,
} from "@/lib/rfRouting";
import type { Radio as RadioType } from "@/lib/protocol";

/**
 * Configuração de roteamento RF para a fazenda.
 * Persistido na tabela `rf_routing` na nuvem (1 linha por farm) e em localStorage.
 * É lido pelo automático (run_automation_tick) e pelos comandos manuais do Dashboard
 * para montar o frame corretamente — direto ou via repetidor (REP:R3:TX:Rx:).
 */
const RfRoutingConfig = () => {
  const { user } = useAuth();
  const [farmId, setFarmId] = useState<string | null>(null);
  const [cfg, setCfg] = useState<RfRoutingCfg>(() => loadRfRouting());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    void supabase
      .from("profiles")
      .select("default_farm_id")
      .eq("id", user.id)
      .maybeSingle()
      .then(async ({ data }) => {
        if (cancelled) return;
        const fid = data?.default_farm_id ?? null;
        setFarmId(fid);
        if (fid) {
          await pullRfRoutingFromCloud(fid);
          if (!cancelled) setCfg(loadRfRouting());
        }
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [user?.id]);

  const updateRadio = (value: string) => {
    setCfg((prev) => ({ ...prev, radio: value as RadioType }));
    setDirty(true);
  };

  const updateViaRep = (checked: boolean) => {
    setCfg((prev) => ({ ...prev, viaRepetidor: checked }));
    setDirty(true);
  };

  const handleSave = async () => {
    if (!farmId) {
      notify.fail("Roteamento RF", "Fazenda não identificada");
      return;
    }
    setSaving(true);
    try {
      await saveRfRoutingCloud(farmId, cfg);
      setDirty(false);
      notify.ok("Roteamento RF", "Roteamento RF salvo na nuvem");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notify.fail("Roteamento RF", `Falha ao salvar: ${msg}`);
    } finally {
      setSaving(false);
    }
  };

  const handleReload = async () => {
    if (!farmId) return;
    setLoading(true);
    await pullRfRoutingFromCloud(farmId);
    setCfg(loadRfRouting());
    setDirty(false);
    setLoading(false);
    notify.ok("Roteamento RF", "Roteamento atualizado da nuvem");
  };

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="text-base text-foreground flex items-center gap-2">
          <Radio className="w-4 h-4 text-primary" />
          Roteamento RF — Comunicação com Bombas
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Define o caminho que os comandos seguem até as bombas — vale tanto para
          o botão manual no Dashboard quanto para o automático na nuvem. Se a
          fazenda usa um Repetidor entre o Servidor e as bombas, ative a opção
          abaixo. Caso contrário, deixe em "Direto".
        </p>

        <div className="flex items-center justify-between p-3 bg-secondary rounded-lg">
          <div>
            <p className="text-sm font-medium text-foreground">
              {cfg.viaRepetidor ? "Via Repetidor (REP:R3)" : "Direto (Servidor)"}
            </p>
            <p className="text-xs text-muted-foreground">
              {cfg.viaRepetidor
                ? "Os frames são prefixados com REP:R3:TX:Rx: e enviados pelo Repetidor."
                : "Os frames são enviados direto pelo Servidor sem prefixo de roteamento."}
            </p>
          </div>
          <Switch
            checked={cfg.viaRepetidor}
            onCheckedChange={updateViaRep}
            disabled={loading || saving}
            className="data-[state=checked]:bg-primary"
          />
        </div>

        <div className="flex items-center justify-between p-3 bg-secondary rounded-lg">
          <div>
            <Label className="text-sm font-medium text-foreground">Rádio de Transmissão</Label>
            <p className="text-xs text-muted-foreground">
              Qual rádio do Servidor é usado para enviar os comandos.
            </p>
          </div>
          <Select value={cfg.radio} onValueChange={updateRadio} disabled={loading || saving}>
            <SelectTrigger className="w-24 bg-card">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="R1">R1</SelectItem>
              <SelectItem value="R2">R2</SelectItem>
              <SelectItem value="R3">R3</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2 pt-2">
          <Button onClick={handleSave} disabled={!dirty || saving || loading} className="gap-2">
            <Save className="w-4 h-4" />
            {saving ? "Salvando..." : "Salvar"}
          </Button>
          <Button variant="outline" onClick={handleReload} disabled={loading || saving} className="gap-2">
            <RefreshCw className="w-4 h-4" />
            Recarregar da nuvem
          </Button>
          {dirty && (
            <span className="text-xs text-warning ml-auto">Alterações não salvas</span>
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default RfRoutingConfig;
