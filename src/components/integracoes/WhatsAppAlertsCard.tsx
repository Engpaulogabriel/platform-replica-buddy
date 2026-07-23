import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Bell, BellOff, Info } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

type Settings = {
  id?: string;
  alerts_enabled: boolean;
  alert_offline_enabled: boolean;
  alert_local_change_enabled: boolean;
  alert_peak_hours_enabled: boolean;
  peak_hour_start: string; // "HH:MM" or "HH:MM:SS"
  peak_hour_end: string;
  peak_hour_weekdays: number[]; // 1=Mon..7=Sun
};

const DEFAULTS: Settings = {
  alerts_enabled: false,
  alert_offline_enabled: true,
  alert_local_change_enabled: true,
  alert_peak_hours_enabled: true,
  peak_hour_start: "18:00",
  peak_hour_end: "21:00",
  peak_hour_weekdays: [1, 2, 3, 4, 5],
};

const WEEKDAYS: { value: number; label: string }[] = [
  { value: 1, label: "Seg" },
  { value: 2, label: "Ter" },
  { value: 3, label: "Qua" },
  { value: 4, label: "Qui" },
  { value: 5, label: "Sex" },
  { value: 6, label: "Sáb" },
  { value: 7, label: "Dom" },
];

// Tipos do Supabase ainda não conhecem peak_hour_weekdays; cast leve.
const sb = supabase as unknown as { from: (t: string) => any };

function trimTime(v: string | null | undefined, fallback: string): string {
  if (!v) return fallback;
  // Postgres returns "HH:MM:SS"; <input type="time"> wants "HH:MM".
  return v.length >= 5 ? v.slice(0, 5) : fallback;
}

export function WhatsAppAlertsCard({ farmId }: { farmId: string | null }) {
  const [s, setS] = useState<Settings>(DEFAULTS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!farmId) return;
    setLoading(true);
    void sb
      .from("whatsapp_alert_settings")
      .select("*")
      .eq("farm_id", farmId)
      .maybeSingle()
      .then(({ data }: { data: any }) => {
        if (data) {
          setS({
            id: data.id,
            alerts_enabled: !!data.alerts_enabled,
            alert_offline_enabled: data.alert_offline_enabled !== false,
            alert_local_change_enabled: data.alert_local_change_enabled !== false,
            alert_peak_hours_enabled: data.alert_peak_hours_enabled !== false,
            peak_hour_start: trimTime(data.peak_hour_start, DEFAULTS.peak_hour_start),
            peak_hour_end: trimTime(data.peak_hour_end, DEFAULTS.peak_hour_end),
            peak_hour_weekdays:
              Array.isArray(data.peak_hour_weekdays) && data.peak_hour_weekdays.length
                ? data.peak_hour_weekdays
                : DEFAULTS.peak_hour_weekdays,
          });
        } else {
          setS(DEFAULTS);
        }
        setLoading(false);
      });
  }, [farmId]);

  const persist = async (next: Settings) => {
    if (!farmId) return;
    setS(next);
    const payload = {
      farm_id: farmId,
      alerts_enabled: next.alerts_enabled,
      alert_offline_enabled: next.alert_offline_enabled,
      alert_local_change_enabled: next.alert_local_change_enabled,
      alert_peak_hours_enabled: next.alert_peak_hours_enabled,
      peak_hour_start: next.peak_hour_start,
      peak_hour_end: next.peak_hour_end,
      peak_hour_weekdays: [...next.peak_hour_weekdays].sort((a, b) => a - b),
    };
    if (next.id) {
      const { error } = await sb.from("whatsapp_alert_settings").update(payload).eq("id", next.id);
      if (error) toast.error("Falha ao salvar alertas");
    } else {
      const { data, error } = await sb
        .from("whatsapp_alert_settings")
        .insert(payload)
        .select("id")
        .single();
      if (error) toast.error("Falha ao salvar alertas");
      else if (data?.id) setS((p) => ({ ...p, id: data.id }));
    }
  };

  const master = s.alerts_enabled;
  const peakOn = master && s.alert_peak_hours_enabled;

  const toggleWeekday = (value: number) => {
    const has = s.peak_hour_weekdays.includes(value);
    const next = has
      ? s.peak_hour_weekdays.filter((d) => d !== value)
      : [...s.peak_hour_weekdays, value];
    void persist({ ...s, peak_hour_weekdays: next });
  };

  return (
    <Card className={`border-2 ${master ? "border-[#25D366]/40" : "border-border"}`}>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <div
            className={`rounded-2xl p-3 border ${
              master
                ? "bg-[#25D366]/15 border-[#25D366]/30"
                : "bg-muted border-border"
            }`}
          >
            {master ? (
              <Bell className="w-8 h-8 text-[#25D366]" />
            ) : (
              <BellOff className="w-8 h-8 text-muted-foreground" />
            )}
          </div>
          <div>
            <CardTitle className="flex items-center gap-2 flex-wrap">
              Alertas Proativos
              {master ? (
                <Badge className="bg-[#25D366]/15 text-[#1ea952] border border-[#25D366]/40">
                  🟢 Ativo
                </Badge>
              ) : (
                <Badge className="bg-muted text-muted-foreground border border-border">
                  ⏸️ Pausado
                </Badge>
              )}
            </CardTitle>
            <CardDescription className="mt-1">
              Envio automático de alertas via WhatsApp quando eventos importantes ocorrem.
            </CardDescription>
          </div>
        </div>
        <Switch
          checked={master}
          disabled={loading || !farmId}
          onCheckedChange={(v) => persist({ ...s, alerts_enabled: v })}
        />
      </CardHeader>

      <CardContent className="space-y-3">
        {[
          {
            key: "alert_local_change_enabled" as const,
            icon: "🔔",
            label: "Mudança Local",
            desc: "Alertar quando equipamento ligar/desligar localmente sem comando remoto",
          },
          {
            key: "alert_offline_enabled" as const,
            icon: "📡",
            label: "Equipamento Offline",
            desc: "Alertar quando equipamento perder comunicação",
          },
          {
            key: "alert_peak_hours_enabled" as const,
            icon: "⚡",
            label: "Horário de Ponta",
            desc: "Alertar quando equipamentos estiverem ligados no horário de ponta",
          },
        ].map((row) => (
          <div
            key={row.key}
            className={`flex items-start justify-between gap-3 rounded-lg border border-border/60 px-3 py-3 ${
              master ? "" : "opacity-60"
            }`}
          >
            <div className="flex items-start gap-3 min-w-0">
              <span className="text-xl leading-none mt-0.5">{row.icon}</span>
              <div className="min-w-0">
                <div className="text-sm font-medium">{row.label}</div>
                <div className="text-xs text-muted-foreground">{row.desc}</div>
              </div>
            </div>
            <Switch
              checked={s[row.key]}
              disabled={!master || loading || !farmId}
              onCheckedChange={(v) => persist({ ...s, [row.key]: v })}
            />
          </div>
        ))}

        {peakOn && (
          <div className="rounded-lg border border-border/60 px-3 py-3 space-y-3 bg-muted/30">
            <div className="text-sm font-medium flex items-center gap-2">
              ⚡ Configuração do Horário de Ponta
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="peak-start" className="text-xs">Início</Label>
                <Input
                  id="peak-start"
                  type="time"
                  value={s.peak_hour_start}
                  onChange={(e) => persist({ ...s, peak_hour_start: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="peak-end" className="text-xs">Fim</Label>
                <Input
                  id="peak-end"
                  type="time"
                  value={s.peak_hour_end}
                  onChange={(e) => persist({ ...s, peak_hour_end: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Dias da semana</Label>
              <div className="flex flex-wrap gap-2">
                {WEEKDAYS.map((d) => {
                  const checked = s.peak_hour_weekdays.includes(d.value);
                  return (
                    <label
                      key={d.value}
                      className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs cursor-pointer select-none ${
                        checked
                          ? "border-[#25D366]/50 bg-[#25D366]/10 text-foreground"
                          : "border-border text-muted-foreground"
                      }`}
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => toggleWeekday(d.value)}
                      />
                      {d.label}
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        <div className="flex items-start gap-2 rounded-lg border border-border/60 bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          <Info className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="space-y-1">
            <div>
              Alertas são enviados para todos os operadores ativos. Anti-spam: mesmo alerta não repete em 30 minutos.
            </div>
            <div>
              Também pode controlar via WhatsApp: envie <strong>"alertas on"</strong> ou{" "}
              <strong>"alertas off"</strong>.
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
