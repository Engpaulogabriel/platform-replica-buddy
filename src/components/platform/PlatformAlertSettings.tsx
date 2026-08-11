// Configuração de Alertas WhatsApp — por fazenda (opt-in).
// ─────────────────────────────────────────────────────────────────────────────
// • Ativa/desativa por fazenda: LIGAR/DESLIGAR, SEM RESPOSTA, COMUNICAÇÃO
//   RESTAURADA, HORÁRIO DE PICO. Default = tudo desativado.
// • AGENTE OFFLINE e BRIDGE MORTA são OBRIGATÓRIOS (1x por ocorrência, lembrete
//   diário) e NÃO podem ser desativados — mostrados como travados.
// • Define QUEM recebe (admin | operadores | todos).
// • Resumo consolidado das fazendas offline (sem heartbeat > 5 min).
// Grava em whatsapp_alert_settings (colunas opt-in). Lido por whatsapp-alerts.
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { notify } from "@/lib/notify";
import { Bell, Lock, RefreshCw, WifiOff, ShieldAlert } from "lucide-react";

interface Farm { id: string; name: string }
interface Settings {
  farm_id: string;
  alerts_master_enabled: boolean;
  alert_ligar_desligar: boolean;
  alert_sem_resposta: boolean;
  alert_com_restaurada: boolean;
  alert_pico: boolean;
  alert_recipients: string; // admin | operators | all
}
interface OfflineFarm { farm_id: string; name: string; minutes: number }

const DEFAULTS: Omit<Settings, "farm_id"> = {
  alerts_master_enabled: false,
  alert_ligar_desligar: false,
  alert_sem_resposta: false,
  alert_com_restaurada: false,
  alert_pico: false,
  alert_recipients: "admin",
};

const TYPE_TOGGLES: Array<{ key: keyof Settings; label: string; hint: string }> = [
  { key: "alert_ligar_desligar", label: "Ligar / Desligar", hint: "Acionamento de bombas (inclui via Local)" },
  { key: "alert_sem_resposta", label: "Sem resposta", hint: "Equipamentos sem comunicação" },
  { key: "alert_com_restaurada", label: "Comunicação restaurada", hint: "Voltou a comunicar" },
  { key: "alert_pico", label: "Horário de pico", hint: "Aviso de janela de ponta" },
];

export default function PlatformAlertSettings({ isAdmin: _isAdmin }: { isAdmin: boolean }) {
  const [farms, setFarms] = useState<Farm[]>([]);
  const [byFarm, setByFarm] = useState<Record<string, Settings>>({});
  const [offline, setOffline] = useState<OfflineFarm[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: farmRows }, { data: settingsRows }, { data: shRows }] = await Promise.all([
      supabase.from("farms").select("id, name").order("name"),
      supabase.from("whatsapp_alert_settings").select("*"),
      supabase.from("site_health").select("farm_id, last_heartbeat"),
    ]);
    const fList = ((farmRows ?? []) as any[]).filter((f) => f?.id && f?.name);
    setFarms(fList);

    const map: Record<string, Settings> = {};
    for (const f of fList) map[f.id] = { farm_id: f.id, ...DEFAULTS };
    for (const s of (settingsRows ?? []) as any[]) {
      if (!s?.farm_id || !map[s.farm_id]) continue;
      map[s.farm_id] = {
        farm_id: s.farm_id,
        alerts_master_enabled: s.alerts_master_enabled === true,
        alert_ligar_desligar: s.alert_ligar_desligar === true,
        alert_sem_resposta: s.alert_sem_resposta === true,
        alert_com_restaurada: s.alert_com_restaurada === true,
        alert_pico: s.alert_pico === true,
        alert_recipients: String(s.alert_recipients ?? "admin"),
      };
    }
    setByFarm(map);

    const now = Date.now();
    const nameById = new Map(fList.map((f) => [f.id, f.name]));
    const off: OfflineFarm[] = ((shRows ?? []) as any[])
      .filter((r) => r?.farm_id && r?.last_heartbeat && nameById.has(r.farm_id))
      .map((r) => ({ farm_id: r.farm_id, name: nameById.get(r.farm_id)!, minutes: Math.floor((now - new Date(r.last_heartbeat).getTime()) / 60000) }))
      .filter((r) => r.minutes >= 5)
      .sort((a, b) => b.minutes - a.minutes);
    setOffline(off);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const persist = async (farmId: string, next: Settings) => {
    setSavingId(farmId);
    const { error } = await supabase
      .from("whatsapp_alert_settings")
      .upsert({ ...next } as any, { onConflict: "farm_id" });
    setSavingId(null);
    if (error) {
      notify.fail("Alertas", "Não foi possível salvar. Tente novamente.");
      void load();
    }
  };

  const update = (farmId: string, patch: Partial<Settings>) => {
    setByFarm((prev) => {
      const next = { ...prev[farmId], ...patch };
      const merged = { ...prev, [farmId]: next };
      void persist(farmId, next);
      return merged;
    });
  };

  return (
    <div className="space-y-4">
      {/* Obrigatórios + resumo offline */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-primary" /> Alertas obrigatórios (sempre ativos)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className="gap-1"><Lock className="w-3 h-3" /> Agente Offline</Badge>
            <Badge variant="outline" className="gap-1"><Lock className="w-3 h-3" /> Bridge Morta</Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Enviados 1× por ocorrência (lembrete diário se persistir). Não podem ser desativados.
          </p>
          <div className="pt-2 border-t border-border">
            <div className="flex items-center gap-2 text-sm font-medium">
              <WifiOff className="w-4 h-4 text-destructive" /> Fazendas offline agora ({offline.length})
            </div>
            {offline.length === 0 ? (
              <p className="text-xs text-muted-foreground mt-1">Todas com heartbeat recente. ✅</p>
            ) : (
              <ul className="mt-2 space-y-1">
                {offline.map((o) => (
                  <li key={o.farm_id} className="text-xs flex justify-between border-b border-border/50 py-1">
                    <span className="font-medium">{o.name}</span>
                    <span className="text-destructive">sem heartbeat há {o.minutes} min</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`w-4 h-4 mr-1.5 ${loading ? "animate-spin" : ""}`} /> Atualizar
          </Button>
        </CardContent>
      </Card>

      {/* Config por fazenda */}
      <Card className="bg-card border-border">
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Bell className="w-4 h-4 text-primary" /> Alertas configuráveis por fazenda
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {loading && farms.length === 0 ? (
            <p className="text-sm text-muted-foreground">Carregando…</p>
          ) : farms.map((f) => {
            const s = byFarm[f.id] ?? { farm_id: f.id, ...DEFAULTS };
            const master = s.alerts_master_enabled;
            return (
              <div key={f.id} className="rounded-md border border-border p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="font-medium text-sm">{f.name}</div>
                  <div className="flex items-center gap-2">
                    {savingId === f.id && <span className="text-[10px] text-muted-foreground">salvando…</span>}
                    <span className="text-xs text-muted-foreground">Ativar alertas</span>
                    <Switch checked={master} onCheckedChange={(v) => update(f.id, { alerts_master_enabled: v })} />
                  </div>
                </div>
                <div className={`mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2 ${master ? "" : "opacity-50 pointer-events-none"}`}>
                  {TYPE_TOGGLES.map((t) => (
                    <label key={String(t.key)} className="flex items-center justify-between gap-2 text-xs bg-muted/40 rounded px-2 py-1.5">
                      <span>
                        <span className="font-medium">{t.label}</span>
                        <span className="block text-[10px] text-muted-foreground">{t.hint}</span>
                      </span>
                      <Switch
                        checked={Boolean(s[t.key])}
                        onCheckedChange={(v) => update(f.id, { [t.key]: v } as Partial<Settings>)}
                      />
                    </label>
                  ))}
                </div>
                <div className={`mt-2 flex flex-col sm:flex-row sm:items-center gap-2 ${master ? "" : "opacity-50 pointer-events-none"}`}>
                  <span className="text-xs text-muted-foreground">Quem recebe:</span>
                  <Select value={s.alert_recipients} onValueChange={(v) => update(f.id, { alert_recipients: v })}>
                    <SelectTrigger className="h-8 w-full sm:w-[160px] text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="admin">Só admin</SelectItem>
                      <SelectItem value="operators">Operadores</SelectItem>
                      <SelectItem value="all">Todos</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
