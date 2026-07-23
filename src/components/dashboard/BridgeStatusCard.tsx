// Card detalhado da bridge Electron — exibido no Dashboard
import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Cpu, AlertTriangle, Globe, Radio, ListOrdered } from "lucide-react";
import { useElectronBridgeStatus, formatBeatAge, type BridgeStatus } from "@/hooks/useElectronBridgeStatus";
import { useCommandQueueStatus } from "@/hooks/useCommandQueueStatus";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";

const cfg: Record<BridgeStatus, { color: string; bg: string; ring: string; label: string; desc: string; pulse: boolean }> = {
  ok: {
    color: "text-primary", bg: "bg-primary/10", ring: "ring-primary/30",
    label: "Bridge Conectada",
    desc: "Agente comunicando — bombas sendo monitoradas via rádio.",
    pulse: true,
  },
  "no-port": {
    color: "text-warning", bg: "bg-warning/10", ring: "ring-warning/30",
    label: "Bridge presente, sem porta COM",
    desc: "Abra a porta serial em Diagnóstico → Hardware.",
    pulse: false,
  },
  stale: {
    color: "text-destructive", bg: "bg-destructive/10", ring: "ring-destructive/30",
    label: "Bridge Offline",
    desc: "Sem comunicação com o agente há mais de 3 min — bombas sem monitoramento.",
    pulse: false,
  },
  error: {
    color: "text-destructive", bg: "bg-destructive/10", ring: "ring-destructive/30",
    label: "Bridge com erro",
    desc: "Falha ao carregar serialport.",
    pulse: false,
  },
  "no-bridge": {
    color: "text-muted-foreground", bg: "bg-muted/30", ring: "ring-border",
    label: "Sem Bridge (modo web)",
    desc: "Use o aplicativo desktop (.exe) para controlar bombas.",
    pulse: false,
  },
};

export function BridgeStatusCard() {
  const { status, present, portOpen, lastBeatAt, loadError, pingState } = useElectronBridgeStatus();
  const { user } = useAuth();
  const [farmId, setFarmId] = useState<string | null>(null);
  useEffect(() => {
    if (!user?.id) return;
    void supabase.from("profiles").select("default_farm_id").eq("id", user.id).maybeSingle()
      .then(({ data }) => setFarmId(data?.default_farm_id ?? null));
  }, [user?.id]);
  const queue = useCommandQueueStatus(farmId);
  const c = cfg[status];
  const Icon = status === "no-bridge" ? Globe
    : status === "error" ? AlertTriangle
    : Cpu;

  return (
    <Card className={`border ${c.ring} ring-1`}>
      <CardContent className="p-3 flex items-center gap-3">
        <div className={`relative w-10 h-10 rounded-xl ${c.bg} flex items-center justify-center shrink-0`}>
          <Icon className={`w-5 h-5 ${c.color}`} />
          {c.pulse && (
            <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-primary animate-pulse" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <Radio className={`w-3 h-3 ${c.color}`} />
            <p className={`text-xs font-bold uppercase tracking-wider ${c.color}`}>{c.label}</p>
          </div>
          <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">{c.desc}</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-1 text-[10px] text-muted-foreground">
            <span>Bridge: <strong className="text-foreground">{present ? "presente" : "ausente"}</strong></span>
            <span>Porta COM: <strong className="text-foreground">{portOpen ? "aberta" : "fechada"}</strong></span>
            <span>Heartbeat: <strong className="text-foreground">{formatBeatAge(lastBeatAt)}</strong></span>
            <span>PING: <strong className="text-foreground">{pingState === "waiting" ? "⏳" : pingState === "timeout" ? "❌" : "✅"}</strong></span>
            <span className="flex items-center gap-1">
              <ListOrdered className="w-2.5 h-2.5" />
              Fila: <strong className="text-foreground">{queue.pending} pend. / {queue.sent} env.</strong>
            </span>
          </div>
          {loadError && (
            <p className="text-[10px] text-destructive mt-0.5 truncate" title={loadError}>{loadError}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
