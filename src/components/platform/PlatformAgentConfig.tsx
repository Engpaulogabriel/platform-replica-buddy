// ─────────────────────────────────────────────────────────────────────────────
// PlatformAgentConfig — editor da tabela agent_config por fazenda.
// Permite ao admin alterar remotamente: porta serial, polling, sweep e tx gap.
// O agente Electron detecta a mudança no hot-reload (≤60 s) e aplica sem reiniciar.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Plug, Save, RotateCcw, Search, Info } from "lucide-react";
import { notify } from "@/lib/notify";

type Farm = { id: string; name: string; city: string | null; state: string | null };

type AgentConfigRow = {
  farm_id: string;
  serial_port: string;
  polling_interval_ms: number;
  sweep_timeout_ms: number;
  tx_gap_ms: number;
  updated_at?: string;
};

const DEFAULTS: Omit<AgentConfigRow, "farm_id"> = {
  serial_port: "COM1",
  polling_interval_ms: 11000,
  sweep_timeout_ms: 5000,
  tx_gap_ms: 100,
};

const KNOWN_PORTS = ["COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "COM10", "COM11", "COM12"];

interface Props { isAdmin: boolean }

export default function PlatformAgentConfig({ isAdmin }: Props) {
  const [farms, setFarms] = useState<Farm[]>([]);
  const [filter, setFilter] = useState("");
  const [farmId, setFarmId] = useState<string | null>(null);
  const [config, setConfig] = useState<AgentConfigRow | null>(null);
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
      const { data } = await supabase
        .from("agent_config")
        .select("farm_id, serial_port, polling_interval_ms, sweep_timeout_ms, tx_gap_ms, updated_at")
        .eq("farm_id", farmId)
        .maybeSingle();
      setConfig((data as AgentConfigRow) ?? { farm_id: farmId, ...DEFAULTS });
      setDirty(false);
    })();
  }, [farmId]);

  const setField = <K extends keyof AgentConfigRow>(k: K, v: AgentConfigRow[K]) => {
    if (!config) return;
    setConfig({ ...config, [k]: v });
    setDirty(true);
  };

  const save = async () => {
    if (!config || !farmId) return;
    setSaving(true);
    const payload = {
      farm_id: farmId,
      serial_port: (config.serial_port || "COM1").trim().toUpperCase(),
      polling_interval_ms: config.polling_interval_ms,
      sweep_timeout_ms: config.sweep_timeout_ms,
      tx_gap_ms: config.tx_gap_ms,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from("agent_config")
      .upsert(payload, { onConflict: "farm_id" });
    setSaving(false);
    if (error) { notify.fail("Erro ao salvar", error.message); return; }
    notify.ok("Configuração salva", "O agente aplicará em até 60 segundos sem reiniciar");
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
            <Plug className="w-4 h-4" /> Configuração remota do agente (porta serial &amp; timers)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-400 flex gap-2">
            <Info className="w-4 h-4 mt-0.5 shrink-0" />
            <span>
              Alterações serão aplicadas em <strong>até 60 segundos</strong> sem reiniciar o agente.
              Se a porta serial mudar, a bridge será fechada e reaberta automaticamente.
            </span>
          </div>

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
              <div className="space-y-4">
                {/* Porta serial: dropdown OU texto livre */}
                <div>
                  <Label className="text-foreground text-sm">Porta serial</Label>
                  <p className="text-[11px] text-muted-foreground mt-0.5 mb-1">
                    Porta COM do PC da fazenda onde o cabo do Servidor está conectado.
                  </p>
                  <div className="flex gap-2">
                    <Select
                      value={KNOWN_PORTS.includes(config.serial_port) ? config.serial_port : ""}
                      onValueChange={(v) => setField("serial_port", v)}
                      disabled={!isAdmin}
                    >
                      <SelectTrigger className="bg-secondary border-border w-40">
                        <SelectValue placeholder="Escolher…" />
                      </SelectTrigger>
                      <SelectContent>
                        {KNOWN_PORTS.map(p => (
                          <SelectItem key={p} value={p}>{p}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      className="bg-secondary border-border font-mono"
                      placeholder="ou digite manualmente (ex: COM23)"
                      value={config.serial_port}
                      onChange={(e) => setField("serial_port", e.target.value.toUpperCase())}
                      disabled={!isAdmin}
                    />
                  </div>
                </div>

                <SliderField
                  label="Polling interval"
                  hint="Intervalo entre cada ciclo de polling automático."
                  unit="ms"
                  value={config.polling_interval_ms}
                  onChange={(v) => setField("polling_interval_ms", v)}
                  min={3000} max={30000} step={500}
                  disabled={!isAdmin}
                />
                <SliderField
                  label="Sweep timeout"
                  hint="Tempo máximo aguardando RX antes de marcar timeout."
                  unit="ms"
                  value={config.sweep_timeout_ms}
                  onChange={(v) => setField("sweep_timeout_ms", v)}
                  min={3000} max={10000} step={250}
                  disabled={!isAdmin}
                />
                <SliderField
                  label="TX gap"
                  hint="Gap mínimo entre duas transmissões serial (anti-colisão RF)."
                  unit="ms"
                  value={config.tx_gap_ms}
                  onChange={(v) => setField("tx_gap_ms", v)}
                  min={50} max={500} step={10}
                  disabled={!isAdmin}
                />

                {config.updated_at && (
                  <p className="text-[11px] text-muted-foreground font-mono">
                    Última atualização: {new Date(config.updated_at).toLocaleString("pt-BR")}
                  </p>
                )}
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
            <p className="text-xs text-muted-foreground pt-2">
              Modo somente leitura. Apenas administradores podem editar.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SliderField({
  label, hint, unit, value, onChange, min, max, step, disabled,
}: {
  label: string; hint: string; unit: string;
  value: number; onChange: (v: number) => void;
  min: number; max: number; step: number; disabled?: boolean;
}) {
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <Label className="text-foreground text-sm">{label}</Label>
        <span className="text-sm font-mono text-primary">{value} {unit}</span>
      </div>
      <p className="text-[11px] text-muted-foreground mt-0.5 mb-2">{hint}</p>
      <Slider
        value={[value]}
        min={min}
        max={max}
        step={step}
        onValueChange={(arr) => onChange(arr[0] ?? value)}
        disabled={disabled}
      />
      <div className="flex justify-between text-[10px] text-muted-foreground font-mono mt-1">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}
