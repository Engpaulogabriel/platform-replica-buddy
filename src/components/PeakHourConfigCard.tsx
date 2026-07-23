import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Zap } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useDefaultFarmId } from "@/hooks/useDefaultFarmId";
import { toast } from "sonner";

interface Eq { id: string; name: string; type: string }
interface PeakCfg {
  id?: string;
  enabled: boolean;
  start_time: string;
  end_time: string;
  auto_restart: boolean;
  excluded_equipment_ids: string[];
}

const DEFAULT_CFG: PeakCfg = {
  enabled: false,
  start_time: "17:30",
  end_time: "21:00",
  auto_restart: true,
  excluded_equipment_ids: [],
};

export default function PeakHourConfigCard() {
  const farmId = useDefaultFarmId();
  const [cfg, setCfg] = useState<PeakCfg>(DEFAULT_CFG);
  const [equipments, setEquipments] = useState<Eq[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!farmId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      const [cfgRes, eqRes] = await Promise.all([
        supabase.from("peak_hour_config" as any).select("*").eq("farm_id", farmId).maybeSingle(),
        supabase.from("equipments").select("id, name, type").eq("farm_id", farmId)
          .in("type", ["poco", "bombeamento"] as any).order("name"),
      ]);
      if (cancelled) return;
      if (cfgRes.data) {
        const d = cfgRes.data as any;
        setCfg({
          id: d.id,
          enabled: !!d.enabled,
          start_time: String(d.start_time).slice(0, 5),
          end_time: String(d.end_time).slice(0, 5),
          auto_restart: !!d.auto_restart,
          excluded_equipment_ids: d.excluded_equipment_ids ?? [],
        });
      }
      setEquipments((eqRes.data as any) ?? []);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [farmId]);

  const toggleExcluded = (id: string, checked: boolean) => {
    setCfg(c => ({
      ...c,
      excluded_equipment_ids: checked
        ? c.excluded_equipment_ids.filter(x => x !== id)
        : [...c.excluded_equipment_ids, id],
    }));
  };

  const save = async () => {
    if (!farmId) return;
    setSaving(true);
    const payload = {
      farm_id: farmId,
      enabled: cfg.enabled,
      start_time: cfg.start_time,
      end_time: cfg.end_time,
      auto_restart: cfg.auto_restart,
      excluded_equipment_ids: cfg.excluded_equipment_ids,
    };
    const { error } = await supabase
      .from("peak_hour_config" as any)
      .upsert(payload, { onConflict: "farm_id" });
    setSaving(false);
    if (error) {
      toast.error("Erro ao salvar: " + error.message);
    } else {
      toast.success("Configuração de Horário de Ponta salva");
    }
  };

  const disabled = !cfg.enabled;

  return (
    <Card className="bg-card border-border">
      <CardHeader>
        <CardTitle className="text-base text-foreground flex items-center gap-2">
          <Zap className="w-4 h-4 text-warning" /> Horário de Ponta — Desligamento Automático
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center justify-between p-3 bg-secondary rounded-lg">
          <div>
            <p className="text-sm font-medium text-foreground">
              Desligar bombas automaticamente no Horário de Ponta
            </p>
            <p className="text-xs text-muted-foreground">
              Pausa a captação durante o pico tarifário para reduzir o custo de energia.
            </p>
          </div>
          <Switch
            checked={cfg.enabled}
            onCheckedChange={(v) => setCfg(c => ({ ...c, enabled: v }))}
            disabled={loading}
          />
        </div>

        <div className={disabled ? "opacity-50 pointer-events-none space-y-5" : "space-y-5"}>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Início</Label>
              <Input
                type="time"
                value={cfg.start_time}
                onChange={(e) => setCfg(c => ({ ...c, start_time: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Fim</Label>
              <Input
                type="time"
                value={cfg.end_time}
                onChange={(e) => setCfg(c => ({ ...c, end_time: e.target.value }))}
              />
            </div>
          </div>

          <div className="flex items-center justify-between p-3 bg-secondary rounded-lg">
            <div>
              <p className="text-sm font-medium text-foreground">
                Religar automaticamente após Horário de Ponta
              </p>
              <p className="text-xs text-muted-foreground">
                Ao final do pico, religa as bombas que foram desligadas pelo sistema.
              </p>
            </div>
            <Switch
              checked={cfg.auto_restart}
              onCheckedChange={(v) => setCfg(c => ({ ...c, auto_restart: v }))}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-sm text-foreground">
              Bombas afetadas (desmarque para manter ligada durante o pico)
            </Label>
            <div className="grid sm:grid-cols-2 gap-2 max-h-64 overflow-auto p-2 bg-secondary/50 rounded-lg border border-border">
              {equipments.length === 0 && (
                <p className="text-xs text-muted-foreground col-span-2">Nenhuma bomba cadastrada.</p>
              )}
              {equipments.map(e => {
                const included = !cfg.excluded_equipment_ids.includes(e.id);
                return (
                  <label
                    key={e.id}
                    className="flex items-center gap-2 p-2 rounded bg-background/40 cursor-pointer"
                  >
                    <Checkbox
                      checked={included}
                      onCheckedChange={(v) => toggleExcluded(e.id, !!v)}
                    />
                    <span className="text-sm text-foreground">{e.name}</span>
                  </label>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <Button onClick={save} disabled={saving || loading} className="bg-primary text-primary-foreground">
            {saving ? "Salvando..." : "Salvar"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
