// ============================================================================
// INEMA — Painel de Compliance Hídrico (Risco de Multa).
// Cruza uso REAL do dia (horas + volume) com os limites da outorga por poço
// (tabela inema_permits). Barras de progresso com threshold: amarelo ≥80%,
// vermelho ≥95% (alerta ANTES de estourar). + aviso de vencimento + form de
// edição da outorga por poço (sem SQL).
// ============================================================================
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useHorimetro } from "@/hooks/useHorimetro";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AlertTriangle, CalendarClock, Droplet, Clock, Pencil, ShieldCheck } from "lucide-react";

// Thresholds globais (o cliente quer alerta ANTES de estourar).
const YELLOW_PCT = 80;
const RED_PCT = 95;

export interface InemaPermit {
  id?: string;
  farm_id: string;
  equipment_id: string;
  portaria_number: string | null;
  processo_number: string | null;
  titular_name: string | null;
  max_daily_hours: number | null;
  max_daily_volume_m3: number | null;
  expiration_date: string | null;
  latitude: number | null;
  longitude: number | null;
  observacoes: string | null;
}

interface WellCompliance {
  equipmentId: string;
  name: string;
  hoursToday: number;
  hoursLimit: number | null;
  hoursPct: number | null;
  volumeToday: number | null;
  volumeLimit: number | null;
  volumePct: number | null;
  volumeSource: "telemetria" | "estimado" | "—";
  status: "ok" | "warn" | "over" | "no-permit";
  permit: InemaPermit | null;
  daysToExpiry: number | null;
}

const pctColor = (pct: number | null): string =>
  pct == null ? "bg-muted"
  : pct >= RED_PCT ? "bg-destructive"
  : pct >= YELLOW_PCT ? "bg-amber-500"
  : "bg-primary";

const worstStatus = (h: number | null, v: number | null): WellCompliance["status"] => {
  const m = Math.max(h ?? 0, v ?? 0);
  if (h == null && v == null) return "ok";
  return m >= RED_PCT ? "over" : m >= YELLOW_PCT ? "warn" : "ok";
};

function daysBetween(dateIso: string | null): number | null {
  if (!dateIso) return null;
  const d = new Date(dateIso + "T00:00:00");
  if (isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86400000);
}

/** Hook de compliance: outorgas + horas de hoje + volume do dia por poço. */
export function useInemaCompliance(farmId: string | null | undefined) {
  const [permits, setPermits] = useState<InemaPermit[]>([]);
  const [equip, setEquip] = useState<Record<string, { name: string; estimated_flow_m3h: number | null; flow_total_m3: number | null; flow_daily_start_m3: number | null }>>({});
  const [loading, setLoading] = useState(true);

  const todayStart = useMemo(() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }, []);
  const now = useMemo(() => new Date(), []);
  const hori = useHorimetro({ from: todayStart, to: now, enabled: !!farmId });

  const load = useCallback(async () => {
    if (!farmId) return;
    setLoading(true);
    const [{ data: perms }, { data: eqs }] = await Promise.all([
      supabase.from("inema_permits" as any).select("*").eq("farm_id", farmId),
      supabase.from("equipments").select("id,name,estimated_flow_m3h,flow_total_m3,flow_daily_start_m3").eq("farm_id", farmId).eq("type", "poco"),
    ]);
    setPermits(((perms as any[]) ?? []) as InemaPermit[]);
    const map: typeof equip = {};
    for (const e of ((eqs as any[]) ?? [])) {
      map[e.id] = { name: e.name, estimated_flow_m3h: e.estimated_flow_m3h ?? null, flow_total_m3: e.flow_total_m3 ?? null, flow_daily_start_m3: e.flow_daily_start_m3 ?? null };
    }
    setEquip(map);
    setLoading(false);
  }, [farmId]);
  useEffect(() => { void load(); }, [load]);

  const hoursByEq = useMemo(() => {
    const m: Record<string, number> = {};
    for (const p of (hori.byPump ?? [])) m[p.equipmentId] = p.monthTotal; // range = hoje
    return m;
  }, [hori.byPump]);

  const wells = useMemo<WellCompliance[]>(() => {
    const byEq = new Map<string, InemaPermit>();
    for (const p of permits) byEq.set(p.equipment_id, p);
    // universo = poços com outorga OU com atividade hoje
    const ids = new Set<string>([...permits.map((p) => p.equipment_id), ...Object.keys(hoursByEq)]);
    const out: WellCompliance[] = [];
    for (const id of ids) {
      const permit = byEq.get(id) ?? null;
      const e = equip[id];
      const name = e?.name ?? permit?.equipment_id?.slice(0, 8) ?? "Poço";
      const hoursToday = Math.round((hoursByEq[id] ?? 0) * 100) / 100;
      const hoursLimit = permit?.max_daily_hours ?? null;
      const hoursPct = hoursLimit && hoursLimit > 0 ? Math.round((hoursToday / hoursLimit) * 1000) / 10 : null;

      // volume: telemetria (flow_total - flow_daily_start) quando houver; senão horas × vazão estimada
      let volumeToday: number | null = null;
      let volumeSource: WellCompliance["volumeSource"] = "—";
      const telemDaily = e && e.flow_total_m3 != null && e.flow_daily_start_m3 != null
        ? e.flow_total_m3 - e.flow_daily_start_m3 : null;
      if (telemDaily != null && telemDaily >= 0) { volumeToday = Math.round(telemDaily); volumeSource = "telemetria"; }
      else if (e?.estimated_flow_m3h) { volumeToday = Math.round(hoursToday * e.estimated_flow_m3h); volumeSource = "estimado"; }

      const volumeLimit = permit?.max_daily_volume_m3 ?? null;
      const volumePct = volumeLimit && volumeLimit > 0 && volumeToday != null ? Math.round((volumeToday / volumeLimit) * 1000) / 10 : null;

      out.push({
        equipmentId: id, name, hoursToday, hoursLimit, hoursPct,
        volumeToday, volumeLimit, volumePct, volumeSource,
        status: permit ? worstStatus(hoursPct, volumePct) : "no-permit",
        permit, daysToExpiry: daysBetween(permit?.expiration_date ?? null),
      });
    }
    return out.sort((a, b) => (b.hoursPct ?? -1) - (a.hoursPct ?? -1));
  }, [permits, equip, hoursByEq]);

  const expiring = useMemo(
    () => wells.filter((w) => w.daysToExpiry != null && w.daysToExpiry <= 90)
      .sort((a, b) => (a.daysToExpiry ?? 0) - (b.daysToExpiry ?? 0)),
    [wells],
  );

  return { wells, expiring, loading: loading || hori.loading, reload: load, permits };
}

function Bar({ label, icon, value, limit, unit, pct, source }: {
  label: string; icon: React.ReactNode; value: number | null; limit: number | null; unit: string; pct: number | null; source?: string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <span className="inline-flex items-center gap-1 text-muted-foreground">{icon}{label}{source && source !== "—" ? <span className="opacity-60">· {source}</span> : null}</span>
        <span className="tabular-nums font-medium">
          {value == null ? "—" : value.toLocaleString("pt-BR")} {limit != null ? <span className="text-muted-foreground">/ {limit.toLocaleString("pt-BR")} {unit}</span> : unit}
          {pct != null ? <span className={pct >= RED_PCT ? "text-destructive ml-1" : pct >= YELLOW_PCT ? "text-amber-600 ml-1" : "text-muted-foreground ml-1"}>({pct}%)</span> : null}
        </span>
      </div>
      <Progress value={pct == null ? 0 : Math.min(100, pct)} className="h-2" indicatorClassName={pctColor(pct)} />
    </div>
  );
}

export function InemaCompliancePanel({ farmId }: { farmId: string | null | undefined }) {
  const { wells, expiring, loading, reload } = useInemaCompliance(farmId);

  return (
    <div className="space-y-4">
      {/* Vencimento < 90 dias */}
      {expiring.length > 0 && (
        <Alert className="border-amber-500/40">
          <CalendarClock className="h-4 w-4" />
          <AlertDescription className="text-sm">
            <strong>Renovação de outorga:</strong>{" "}
            {expiring.map((w) => `${w.name} vence em ${w.daysToExpiry} dia${(w.daysToExpiry ?? 0) === 1 ? "" : "s"}`).join(" · ")}.
          </AlertDescription>
        </Alert>
      )}

      {loading && wells.length === 0 ? (
        <p className="text-sm text-muted-foreground px-1">Carregando compliance…</p>
      ) : wells.length === 0 ? (
        <Alert><ShieldCheck className="h-4 w-4" /><AlertDescription>Nenhum poço com outorga cadastrada ainda. Use "Editar outorga" em cada poço.</AlertDescription></Alert>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {wells.map((w) => (
            <Card key={w.equipmentId} className={w.status === "over" ? "border-destructive/50" : w.status === "warn" ? "border-amber-500/50" : ""}>
              <CardHeader className="pb-2 flex-row items-center justify-between">
                <CardTitle className="text-sm flex items-center gap-2">
                  {w.name}
                  {w.status === "over" && <Badge variant="destructive" className="gap-1"><AlertTriangle className="w-3 h-3" />Risco de infração</Badge>}
                  {w.status === "warn" && <Badge className="bg-amber-500 hover:bg-amber-500 gap-1"><AlertTriangle className="w-3 h-3" />Atenção</Badge>}
                  {w.status === "ok" && <Badge variant="secondary">Dentro do limite</Badge>}
                  {w.status === "no-permit" && <Badge variant="outline">Sem outorga</Badge>}
                </CardTitle>
                <PermitEditDialog farmId={farmId!} equipmentId={w.equipmentId} name={w.name} permit={w.permit} onSaved={reload} />
              </CardHeader>
              <CardContent className="space-y-3">
                <Bar label="Horas hoje" icon={<Clock className="w-3 h-3" />} value={w.hoursToday} limit={w.hoursLimit} unit="h" pct={w.hoursPct} />
                <Bar label="Volume hoje" icon={<Droplet className="w-3 h-3" />} value={w.volumeToday} limit={w.volumeLimit} unit="m³" pct={w.volumePct} source={w.volumeSource} />
                {w.permit?.portaria_number && (
                  <p className="text-[11px] text-muted-foreground pt-1 border-t">
                    Portaria {w.permit.portaria_number} · {w.permit.titular_name ?? "—"}
                    {w.daysToExpiry != null ? ` · validade em ${w.daysToExpiry}d` : ""}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function PermitEditDialog({ farmId, equipmentId, name, permit, onSaved }: {
  farmId: string; equipmentId: string; name: string; permit: InemaPermit | null; onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [f, setF] = useState({
    portaria_number: permit?.portaria_number ?? "",
    processo_number: permit?.processo_number ?? "",
    titular_name: permit?.titular_name ?? "",
    max_daily_hours: permit?.max_daily_hours != null ? String(permit.max_daily_hours) : "18",
    max_daily_volume_m3: permit?.max_daily_volume_m3 != null ? String(permit.max_daily_volume_m3) : "",
    expiration_date: permit?.expiration_date ?? "",
    latitude: permit?.latitude != null ? String(permit.latitude) : "",
    longitude: permit?.longitude != null ? String(permit.longitude) : "",
  });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  const save = async () => {
    setSaving(true);
    const num = (v: string) => (v.trim() === "" ? null : Number(v));
    const payload = {
      farm_id: farmId, equipment_id: equipmentId,
      portaria_number: f.portaria_number || null,
      processo_number: f.processo_number || null,
      titular_name: f.titular_name || null,
      max_daily_hours: num(f.max_daily_hours) ?? 18,
      max_daily_volume_m3: num(f.max_daily_volume_m3),
      expiration_date: f.expiration_date || null,
      latitude: num(f.latitude), longitude: num(f.longitude),
    };
    await supabase.from("inema_permits" as any).upsert(payload, { onConflict: "equipment_id" });
    setSaving(false); setOpen(false); onSaved();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="ghost" className="h-7 px-2 text-xs"><Pencil className="w-3 h-3 mr-1" />Editar outorga</Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Outorga — {name}</DialogTitle></DialogHeader>
        <div className="grid gap-3 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div><Label className="text-xs">Portaria nº</Label><Input value={f.portaria_number} onChange={set("portaria_number")} /></div>
            <div><Label className="text-xs">Titular</Label><Input value={f.titular_name} onChange={set("titular_name")} /></div>
          </div>
          <div><Label className="text-xs">Processo</Label><Input value={f.processo_number} onChange={set("processo_number")} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label className="text-xs">Máx. horas/dia</Label><Input type="number" value={f.max_daily_hours} onChange={set("max_daily_hours")} /></div>
            <div><Label className="text-xs">Máx. volume/dia (m³)</Label><Input type="number" value={f.max_daily_volume_m3} onChange={set("max_daily_volume_m3")} /></div>
          </div>
          <div><Label className="text-xs">Validade</Label><Input type="date" value={f.expiration_date} onChange={set("expiration_date")} /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><Label className="text-xs">Latitude</Label><Input value={f.latitude} onChange={set("latitude")} /></div>
            <div><Label className="text-xs">Longitude</Label><Input value={f.longitude} onChange={set("longitude")} /></div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancelar</Button>
          <Button onClick={save} disabled={saving}>{saving ? "Salvando…" : "Salvar"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
