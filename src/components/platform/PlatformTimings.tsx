import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Timer, Save, RotateCcw, Search } from "lucide-react";
import { notify } from "@/lib/notify";

type Farm = { id: string; name: string; city: string | null; state: string | null };

type TimingRow = {
  farm_id: string;
  comm_system_seconds: number;
  comm_levels_seconds: number;
  offline_auto_seconds: number;
  offline_levels_seconds: number;
  auto_reset_minutes: number;
  default_polling_seconds: number;
  default_command_timeout_ms: number;
  agent_backoff_seconds: number;
  agent_backoff_after_timeouts: number;
  updated_at?: string;
};

const DEFAULTS: Omit<TimingRow, "farm_id"> = {
  comm_system_seconds: 10,
  comm_levels_seconds: 10,
  offline_auto_seconds: 1200,
  offline_levels_seconds: 60,
  auto_reset_minutes: 2,
  default_polling_seconds: 8,
  default_command_timeout_ms: 10000,
  agent_backoff_seconds: 60,
  agent_backoff_after_timeouts: 3,
};

interface Props { isAdmin: boolean }

export default function PlatformTimings({ isAdmin }: Props) {
  const [farms, setFarms] = useState<Farm[]>([]);
  const [filter, setFilter] = useState("");
  const [farmId, setFarmId] = useState<string | null>(null);
  const [config, setConfig] = useState<TimingRow | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("farms").select("id,name,city,state").order("name");
      setFarms((data ?? []) as Farm[]);
      if (data?.length && !farmId) setFarmId(data[0].id);
    })();
  }, []);

  useEffect(() => {
    if (!farmId) return;
    (async () => {
      const { data } = await (supabase as any)
        .from("farm_timing_config")
        .select("*")
        .eq("farm_id", farmId)
        .maybeSingle();
      setConfig((data as TimingRow) ?? { farm_id: farmId, ...DEFAULTS });
      setDirty(false);
    })();
  }, [farmId]);

  const update = (k: keyof typeof DEFAULTS, v: string) => {
    if (!config) return;
    const num = Number.parseInt(v || "0", 10);
    setConfig({ ...config, [k]: Number.isFinite(num) ? num : 0 });
    setDirty(true);
  };

  const save = async () => {
    if (!config || !farmId) return;
    setSaving(true);
    const { data: u } = await supabase.auth.getUser();
    const payload = { ...config, farm_id: farmId, updated_by: u.user?.id ?? null };
    const { error } = await (supabase as any)
      .from("farm_timing_config")
      .upsert(payload, { onConflict: "farm_id" });
    setSaving(false);
    if (error) { notify.fail("Erro ao salvar", error.message); return; }
    notify.ok("Tempos salvos", "Configuração da fazenda atualizada");
    setDirty(false);
  };

  const reset = () => {
    if (!farmId) return;
    setConfig({ farm_id: farmId, ...DEFAULTS });
    setDirty(true);
  };

  const filtered = farms.filter(f =>
    !filter || f.name.toLowerCase().includes(filter.toLowerCase()) ||
    (f.city ?? "").toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="space-y-4">
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base text-foreground flex items-center gap-2">
            <Timer className="w-4 h-4" /> Tempos de comunicação por fazenda
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid md:grid-cols-[1fr,2fr] gap-3">
            <div className="space-y-2">
              <Label>Fazenda</Label>
              <div className="relative">
                <Search className="w-4 h-4 absolute left-2 top-2.5 text-muted-foreground" />
                <Input
                  className="pl-8 bg-secondary border-border"
                  placeholder="Filtrar..."
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
              <Select value={farmId ?? ""} onValueChange={setFarmId}>
                <SelectTrigger className="bg-secondary border-border"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {filtered.map(f => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.name}{f.city ? ` — ${f.city}/${f.state ?? ""}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {config && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Comunicação do sistema (s)" hint="Intervalo entre cada envio de comando" value={config.comm_system_seconds} onChange={v => update("comm_system_seconds", v)} disabled={!isAdmin} min={3} />
                <Field label="Frequência dos níveis (s)" hint="Intervalo de leitura dos sensores de nível" value={config.comm_levels_seconds} onChange={v => update("comm_levels_seconds", v)} disabled={!isAdmin} min={1} />
                <Field label="Offline automação (s)" hint="Sem resposta da automação → offline" value={config.offline_auto_seconds} onChange={v => update("offline_auto_seconds", v)} disabled={!isAdmin} min={10} />
                <Field label="Offline níveis (s)" hint="Sem resposta dos níveis → offline" value={config.offline_levels_seconds} onChange={v => update("offline_levels_seconds", v)} disabled={!isAdmin} min={10} />
                <Field label="Auto-reset comando (min)" hint="Reseta comando pendente sem resposta" value={config.auto_reset_minutes} onChange={v => update("auto_reset_minutes", v)} disabled={!isAdmin} min={1} />
                <Field label="Polling padrão por equipamento (s)" hint="Intervalo de polling padrão para novos equipamentos" value={config.default_polling_seconds} onChange={v => update("default_polling_seconds", v)} disabled={!isAdmin} min={3} />
                <Field label="Timeout de comando (ms)" hint="Tempo máx. esperando resposta de um comando" value={config.default_command_timeout_ms} onChange={v => update("default_command_timeout_ms", v)} disabled={!isAdmin} min={1000} />
                <Field label="Backoff do agente (s)" hint="Pausa de TX após N timeouts consecutivos" value={config.agent_backoff_seconds} onChange={v => update("agent_backoff_seconds", v)} disabled={!isAdmin} min={5} />
                <Field label="Timeouts antes do backoff" hint="Quantidade de timeouts seguidos para acionar backoff" value={config.agent_backoff_after_timeouts} onChange={v => update("agent_backoff_after_timeouts", v)} disabled={!isAdmin} min={1} />
              </div>
            )}
          </div>

          {isAdmin && (
            <div className="flex items-center justify-between gap-3 pt-2">
              <p className="text-xs text-muted-foreground">
                {dirty ? "Você tem alterações não salvas." : "Tudo salvo."}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" onClick={reset} disabled={saving}>
                  <RotateCcw className="w-4 h-4 mr-1.5" /> Restaurar padrões
                </Button>
                <Button onClick={save} disabled={!dirty || saving} className="bg-primary text-primary-foreground">
                  <Save className="w-4 h-4 mr-1.5" /> Salvar
                </Button>
              </div>
            </div>
          )}
          {!isAdmin && (
            <p className="text-xs text-muted-foreground pt-2">Modo somente leitura. Apenas administradores da plataforma podem editar.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, hint, value, onChange, disabled, min }: {
  label: string; hint: string; value: number; onChange: (v: string) => void; disabled?: boolean; min?: number;
}) {
  return (
    <div>
      <Label className="text-foreground text-sm">{label}</Label>
      <p className="text-[11px] text-muted-foreground mt-0.5 mb-1">{hint}</p>
      <Input
        type="number"
        min={min}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="bg-secondary border-border"
      />
    </div>
  );
}
