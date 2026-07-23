// Histórico de Comunicação — pareia eventos `equipamento_offline` / `equipamento_online`
// em ciclos completos (1 linha por queda) e mostra duração total entre offline → online.
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { WifiOff, Wifi, Radio, Download, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";

type Cycle = {
  id: string;
  equipment: string;
  offlineAt: string;          // ISO
  onlineAt: string | null;    // ISO (null = ainda offline)
  durationSec: number;        // se ainda offline, calculado até agora
  ongoing: boolean;
  autoClosed?: boolean;       // fechado pela UI usando last_communication
  attempts?: number | null;
  tsnn?: string | null;
};


interface Props {
  farmId: string | null;
  fromDate: string; // YYYY-MM-DD
  toDate: string;   // YYYY-MM-DD
  equipmentFilter: string; // "all" ou nome do equipamento
}

function fmtDuration(sec?: number | null): string {
  if (sec == null || sec < 0) return "—";
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}min`;
  if (m > 0) return `${m}min ${String(r).padStart(2, "0")}s`;
  return `${r}s`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR");
}
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

const MIN_DURATION_DEFAULT = 30; // segundos

export default function CommunicationReport({ farmId, fromDate, toDate, equipmentFilter }: Props) {
  const [rawCycles, setRawCycles] = useState<Cycle[]>([]);
  const [loading, setLoading] = useState(false);
  const [minDuration, setMinDuration] = useState<number>(MIN_DURATION_DEFAULT);

  useEffect(() => {
    if (!farmId) { setRawCycles([]); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const fromIso = new Date(`${fromDate}T00:00:00`).toISOString();
      const toIso = new Date(`${toDate}T23:59:59.999`).toISOString();
      const [logRes, equipRes] = await Promise.all([
        supabase
          .from("automation_log")
          .select("id, equipment_name, occurred_at, details")
          .eq("farm_id", farmId)
          .gte("occurred_at", fromIso)
          .lte("occurred_at", toIso)
          .in("action", ["status_read"])
          .order("occurred_at", { ascending: true })
          .limit(2000),
        supabase
          .from("equipments")
          .select("name, communication_status, last_communication")
          .eq("farm_id", farmId),
      ]);
      if (cancelled) return;
      const data = logRes.data;
      if (logRes.error || !data) { setRawCycles([]); setLoading(false); return; }

      // Estado atual de comunicação por nome de equipamento (usado para
      // auto-fechar ciclos "em andamento" cujo equipamento já está online).
      const equipStatus = new Map<string, { online: boolean; lastComm: string | null }>();
      for (const e of (equipRes.data ?? []) as Array<{ name: string; communication_status: string | null; last_communication: string | null }>) {
        equipStatus.set(e.name, {
          online: e.communication_status !== "offline",
          lastComm: e.last_communication ?? null,
        });
      }

      // Agrupar eventos por equipamento, ordem cronológica ascendente
      const byEquip: Record<string, Array<{ id: string; tipo: string; at: string; det: any }>> = {};
      for (const r of data as Array<any>) {
        const det = r.details ?? {};
        const tipo = det.tipo_evento;
        if (tipo !== "equipamento_offline" && tipo !== "equipamento_online") continue;
        const key = r.equipment_name;
        if (!byEquip[key]) byEquip[key] = [];
        byEquip[key].push({ id: r.id, tipo, at: r.occurred_at, det });
      }

      const now = Date.now();
      const cycles: Cycle[] = [];
      for (const [equip, evs] of Object.entries(byEquip)) {
        let openOffline: { id: string; at: string; det: any } | null = null;
        for (const ev of evs) {
          if (ev.tipo === "equipamento_offline") {
            openOffline = { id: ev.id, at: ev.at, det: ev.det };
          } else if (ev.tipo === "equipamento_online") {
            if (openOffline) {
              const durMs = new Date(ev.at).getTime() - new Date(openOffline.at).getTime();
              cycles.push({
                id: openOffline.id,
                equipment: equip,
                offlineAt: openOffline.at,
                onlineAt: ev.at,
                durationSec: Math.max(0, Math.round(durMs / 1000)),
                ongoing: false,
                attempts: openOffline.det.tentativas_sem_resposta ?? openOffline.det.tentativas_consecutivas ?? ev.det.tentativas_sem_resposta ?? null,
                tsnn: openOffline.det.tsnn ?? ev.det.tsnn ?? null,
              });
              openOffline = null;
            }
            // online sem offline aberto = ignora (fora da janela)
          }
        }
        if (openOffline) {
          const status = equipStatus.get(equip);
          // Se o equipamento já está online agora, fecha o ciclo usando
          // last_communication (ou now() como fallback) — evita "Em andamento"
          // eterno quando o evento de volta nunca foi registrado.
          if (status?.online) {
            const closeAt = status.lastComm && new Date(status.lastComm).getTime() > new Date(openOffline.at).getTime()
              ? status.lastComm
              : new Date(now).toISOString();
            const durMs = new Date(closeAt).getTime() - new Date(openOffline.at).getTime();
            cycles.push({
              id: openOffline.id,
              equipment: equip,
              offlineAt: openOffline.at,
              onlineAt: closeAt,
              durationSec: Math.max(0, Math.round(durMs / 1000)),
              ongoing: false,
              autoClosed: true,
              attempts: openOffline.det.tentativas_sem_resposta ?? openOffline.det.tentativas_consecutivas ?? null,
              tsnn: openOffline.det.tsnn ?? null,
            });
          } else {
            const durMs = now - new Date(openOffline.at).getTime();
            cycles.push({
              id: openOffline.id,
              equipment: equip,
              offlineAt: openOffline.at,
              onlineAt: null,
              durationSec: Math.max(0, Math.round(durMs / 1000)),
              ongoing: true,
              attempts: openOffline.det.tentativas_sem_resposta ?? openOffline.det.tentativas_consecutivas ?? null,
              tsnn: openOffline.det.tsnn ?? null,
            });
          }
        }
      }

      // Mais recente primeiro
      cycles.sort((a, b) => new Date(b.offlineAt).getTime() - new Date(a.offlineAt).getTime());
      setRawCycles(cycles);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [farmId, fromDate, toDate]);


  const filtered = useMemo(() => {
    return rawCycles.filter(c => {
      if (equipmentFilter !== "all" && c.equipment !== equipmentFilter) return false;
      // ongoing nunca é filtrado por duração mínima
      if (!c.ongoing && c.durationSec < minDuration) return false;
      return true;
    });
  }, [rawCycles, equipmentFilter, minDuration]);

  const stats = useMemo(() => {
    const total = filtered.length;
    const recovered = filtered.filter(c => !c.ongoing);
    const ongoing = filtered.filter(c => c.ongoing).length;
    const totalDownSec = filtered.reduce((s, c) => s + c.durationSec, 0);
    const avg = recovered.length > 0 ? Math.round(recovered.reduce((s, c) => s + c.durationSec, 0) / recovered.length) : 0;
    return { total, recovered: recovered.length, ongoing, totalDownSec, avg };
  }, [filtered]);

  const exportCSV = () => {
    const header = ["Data", "Hora Offline", "Hora Online", "Equipamento", "TSNN", "Duração", "Tentativas"];
    const lines = [header.join(";")];
    for (const c of filtered) {
      lines.push([
        fmtDate(c.offlineAt),
        fmtTime(c.offlineAt),
        c.onlineAt ? fmtTime(c.onlineAt) : "—",
        c.equipment,
        c.tsnn ?? "",
        c.ongoing ? `Em andamento (${fmtDuration(c.durationSec)})` : fmtDuration(c.durationSec),
        c.attempts ?? "",
      ].join(";"));
    }
    const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `historico-comunicacao_${fromDate}_a_${toDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="p-3 text-center">
            <div className="flex items-center justify-center gap-1 text-destructive">
              <WifiOff className="w-3.5 h-3.5" />
              <p className="text-[11px] uppercase tracking-wider font-semibold">Quedas</p>
            </div>
            <p className="text-xl font-bold text-foreground mt-1">{stats.total}</p>
          </CardContent>
        </Card>
        <Card className="border-primary/30 bg-primary/5">
          <CardContent className="p-3 text-center">
            <div className="flex items-center justify-center gap-1 text-primary">
              <Wifi className="w-3.5 h-3.5" />
              <p className="text-[11px] uppercase tracking-wider font-semibold">Recuperadas</p>
            </div>
            <p className="text-xl font-bold text-foreground mt-1">{stats.recovered}{stats.ongoing > 0 && <span className="text-xs text-warning ml-1">+{stats.ongoing} em curso</span>}</p>
          </CardContent>
        </Card>
        <Card className="border-border">
          <CardContent className="p-3 text-center">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Tempo Total Offline</p>
            <p className="text-xl font-bold text-foreground mt-1">{fmtDuration(stats.totalDownSec)}</p>
          </CardContent>
        </Card>
        <Card className="border-border">
          <CardContent className="p-3 text-center">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Duração Média</p>
            <p className="text-xl font-bold text-foreground mt-1">{fmtDuration(stats.avg)}</p>
          </CardContent>
        </Card>
      </div>

      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-base text-foreground flex items-center gap-2">
                <Radio className="w-4 h-4 text-primary" /> Histórico de Comunicação
              </CardTitle>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Cada linha = 1 queda completa (offline → online) • {filtered.length} {filtered.length === 1 ? "evento" : "eventos"}
              </p>
            </div>
            <div className="flex items-end gap-2">
              <div>
                <label className="text-[10px] uppercase tracking-wider text-muted-foreground">Duração mín. (s)</label>
                <Input
                  type="number" min={0} max={3600}
                  value={minDuration}
                  onChange={(e) => setMinDuration(Math.max(0, Number(e.target.value) || 0))}
                  className="bg-secondary border-border mt-1 w-24 h-8"
                />
              </div>
              <Button variant="outline" size="sm" className="border-border text-muted-foreground gap-1" onClick={exportCSV} disabled={filtered.length === 0}>
                <Download className="w-3.5 h-3.5" /> CSV
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {loading ? (
            <div className="px-6 py-12 text-center text-muted-foreground flex items-center justify-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> Carregando histórico…
            </div>
          ) : filtered.length === 0 ? (
            <div className="px-6 py-12 text-center">
              <Wifi className="w-10 h-10 mx-auto mb-3 text-muted-foreground opacity-50" />
              <p className="text-sm font-medium text-foreground">Nenhuma queda de comunicação registrada</p>
              <p className="text-xs text-muted-foreground mt-1">
                Eventos abaixo de {minDuration}s são filtrados como ruído de polling.
              </p>
            </div>
          ) : (
            <>
              {/* Mobile */}
              <div className="sm:hidden divide-y divide-border">
                {filtered.map((c) => (
                  <div key={c.id} className="px-4 py-3 space-y-1.5">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-foreground truncate">{c.equipment}</p>
                        <p className="text-xs text-muted-foreground">{fmtDate(c.offlineAt)}</p>
                      </div>
                      {c.ongoing ? (
                        <span className="shrink-0 text-[10px] font-bold px-2 py-1 rounded-full bg-warning/10 text-warning flex items-center gap-1">
                          <WifiOff className="w-3 h-3" /> EM CURSO
                        </span>
                      ) : (
                        <span className="shrink-0 text-[10px] font-bold px-2 py-1 rounded-full bg-primary/10 text-primary flex items-center gap-1">
                          <Wifi className="w-3 h-3" /> RECUPERADA
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-1 text-xs text-muted-foreground">
                      <div>Offline às: <span className="text-foreground">{fmtTime(c.offlineAt)}</span></div>
                      <div>Online às: <span className="text-foreground">{c.onlineAt ? fmtTime(c.onlineAt) : "—"}</span></div>
                      <div className="col-span-2">
                        Duração: <span className="text-foreground font-semibold">
                          {c.ongoing ? `Em andamento (${fmtDuration(c.durationSec)})` : fmtDuration(c.durationSec)}
                        </span>
                      </div>
                      {c.tsnn && <div>TSNN: <span className="text-foreground">{c.tsnn}</span></div>}
                      {c.attempts != null && <div>Tentativas: <span className="text-foreground">{c.attempts}</span></div>}
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop */}
              <div className="hidden sm:block">
                <Table>
                  <TableHeader>
                    <TableRow className="border-border hover:bg-secondary/50">
                      <TableHead className="text-muted-foreground">Data</TableHead>
                      <TableHead className="text-muted-foreground">Hora Offline</TableHead>
                      <TableHead className="text-muted-foreground">Hora Online</TableHead>
                      <TableHead className="text-muted-foreground">Equipamento</TableHead>
                      <TableHead className="text-muted-foreground">TSNN</TableHead>
                      <TableHead className="text-muted-foreground">Duração Offline</TableHead>
                      <TableHead className="text-muted-foreground text-right">Tentativas</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.map((c) => (
                      <TableRow key={c.id} className="border-border hover:bg-secondary/50">
                        <TableCell className="text-foreground text-sm whitespace-nowrap">{fmtDate(c.offlineAt)}</TableCell>
                        <TableCell className="text-foreground text-sm whitespace-nowrap">
                          <span className="inline-flex items-center gap-1">
                            <WifiOff className="w-3 h-3 text-destructive" />
                            {fmtTime(c.offlineAt)}
                          </span>
                        </TableCell>
                        <TableCell className="text-foreground text-sm whitespace-nowrap">
                          {c.onlineAt ? (
                            <span className="inline-flex items-center gap-1">
                              <Wifi className="w-3 h-3 text-primary" />
                              {fmtTime(c.onlineAt)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell className="text-foreground font-medium">{c.equipment}</TableCell>
                        <TableCell className="text-muted-foreground text-xs">{c.tsnn ?? "—"}</TableCell>
                        <TableCell className="text-sm whitespace-nowrap">
                          {c.ongoing ? (
                            <span className="text-warning font-semibold">Em andamento ({fmtDuration(c.durationSec)})</span>
                          ) : (
                            <span className="text-foreground font-semibold">
                              {fmtDuration(c.durationSec)}
                              {c.autoClosed && <span className="ml-1 text-[10px] text-muted-foreground font-normal">(fechado autom.)</span>}
                            </span>
                          )}
                        </TableCell>

                        <TableCell className="text-foreground text-sm text-right">{c.attempts ?? "—"}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
