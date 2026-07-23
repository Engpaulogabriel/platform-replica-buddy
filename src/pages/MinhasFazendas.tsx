// MinhasFazendas — lista as fazendas que o usuário tem acesso, com role,
// localização e status do agente. Clicar no card define a fazenda ativa
// (profiles.default_farm_id) e navega para o dashboard.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MapPin, Tractor, CheckCircle2, XCircle, Loader2, ArrowRight, Crown } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useUserFarms } from "@/hooks/useUserFarms";

const ROLE_LABEL: Record<string, string> = {
  owner: "Proprietário",
  admin: "Administrador",
  operator: "Operador",
  viewer: "Visualizador",
};
const ROLE_COLOR: Record<string, string> = {
  owner: "bg-primary/15 text-primary border-primary/30",
  admin: "bg-info/15 text-info border-info/30",
  operator: "bg-warning/15 text-warning border-warning/30",
  viewer: "bg-muted text-muted-foreground border-border",
};

interface FarmStat { farmId: string; equipments: number; agentOnline: boolean }

export default function MinhasFazendas() {
  const { farms, activeFarmId, loading, setActiveFarm } = useUserFarms();
  const navigate = useNavigate();
  const [stats, setStats] = useState<Record<string, FarmStat>>({});
  const [switching, setSwitching] = useState<string | null>(null);

  useEffect(() => {
    if (farms.length === 0) return;
    const ids = farms.map(f => f.id);
    void (async () => {
      const [{ data: equips }, { data: health }] = await Promise.all([
        supabase.from("equipments").select("id, farm_id").in("farm_id", ids),
        supabase.from("site_health").select("farm_id, last_heartbeat, com_connected").in("farm_id", ids),
      ]);
      const map: Record<string, FarmStat> = {};
      for (const id of ids) map[id] = { farmId: id, equipments: 0, agentOnline: false };
      for (const e of equips ?? []) {
        if (map[e.farm_id]) map[e.farm_id].equipments++;
      }
      const now = Date.now();
      for (const h of health ?? []) {
        const last = h.last_heartbeat ? new Date(h.last_heartbeat).getTime() : 0;
        const fresh = now - last < 90_000;
        if (map[h.farm_id]) map[h.farm_id].agentOnline = !!h.com_connected && fresh;
      }
      setStats(map);
    })();
  }, [farms]);

  const handleEnter = async (farmId: string) => {
    if (farmId === activeFarmId) {
      navigate("/home");
      return;
    }
    setSwitching(farmId);
    await setActiveFarm(farmId); // dispara reload
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-muted-foreground gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> Carregando fazendas…
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-5xl mx-auto">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center">
          <Tractor className="w-5 h-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-foreground">Minhas Fazendas</h1>
          <p className="text-xs text-muted-foreground">
            {farms.length} fazenda{farms.length === 1 ? "" : "s"} vinculada{farms.length === 1 ? "" : "s"} à sua conta
          </p>
        </div>
      </div>

      {farms.length === 0 ? (
        <Card className="bg-card border-border">
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            Você ainda não está vinculado a nenhuma fazenda.
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {farms.map((f) => {
            const isActive = f.id === activeFarmId;
            const st = stats[f.id];
            const roleKey = f.role as string;
            return (
              <Card
                key={f.id}
                className={`bg-card border-border transition-all hover:border-primary/40 hover:shadow-md cursor-pointer ${isActive ? "ring-2 ring-primary/40" : ""}`}
                onClick={() => handleEnter(f.id)}
              >
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 mb-1">
                        <h3 className="text-sm font-bold text-foreground truncate">{f.name}</h3>
                        {isActive && <Crown className="w-3.5 h-3.5 text-primary shrink-0" aria-label="Fazenda ativa" />}
                      </div>
                      <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                        <MapPin className="w-3 h-3" />
                        {[f.city, f.state].filter(Boolean).join(" / ") || "Localização não informada"}
                      </p>
                    </div>
                    <Badge variant="outline" className={`text-[10px] ${ROLE_COLOR[roleKey] ?? "bg-muted text-muted-foreground"}`}>
                      {ROLE_LABEL[roleKey] ?? roleKey}
                    </Badge>
                  </div>

                  <div className="flex items-center justify-between text-[11px]">
                    <span className="text-muted-foreground">
                      <strong className="text-foreground">{st?.equipments ?? "…"}</strong> equipamentos
                    </span>
                    <span className={`flex items-center gap-1 ${st?.agentOnline ? "text-success" : "text-muted-foreground"}`}>
                      {st?.agentOnline ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
                      Agente {st?.agentOnline ? "online" : "offline"}
                    </span>
                  </div>

                  <Button
                    size="sm"
                    variant={isActive ? "default" : "outline"}
                    className="w-full gap-2"
                    disabled={switching === f.id}
                    onClick={(e) => { e.stopPropagation(); handleEnter(f.id); }}
                  >
                    {switching === f.id ? (
                      <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Trocando…</>
                    ) : isActive ? (
                      <>Ir ao painel <ArrowRight className="w-3.5 h-3.5" /></>
                    ) : (
                      <>Entrar nesta fazenda <ArrowRight className="w-3.5 h-3.5" /></>
                    )}
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
