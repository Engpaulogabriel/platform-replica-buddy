// FarmTopologyDiagram — hierarquia Reservatório → Poços da fazenda.
// Lê equipments.alimenta_id (reservatório principal) e alimenta_alt_id
// (reservatório alternativo — poço compartilhado, desenhado pontilhado).
// Clicar em um poço abre o status atual (ligado/desligado, última comunicação).
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Droplets, Waves, Share2, Radio, Clock, Activity } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { getSupabaseForFarm } from "@/lib/supabaseRouter";
import type { Pump } from "@/components/dashboard/PumpTable";
import { cn } from "@/lib/utils";

interface Node {
  id: string;
  name: string;
  type: string;
  alimenta_id: string | null;
  alimenta_alt_id: string | null;
}

interface Props {
  farmId: string | null;
  pumps: Pump[];
}

const naturalSort = (a: string, b: string) =>
  a.localeCompare(b, "pt-BR", { numeric: true, sensitivity: "base" });

function formatWhen(iso?: string | null) {
  if (!iso) return "sem registro";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "sem registro";
  const diff = Math.floor((Date.now() - d.getTime()) / 1000);
  const rel =
    diff < 60 ? `${diff}s atrás`
      : diff < 3600 ? `${Math.floor(diff / 60)} min atrás`
        : diff < 86400 ? `${Math.floor(diff / 3600)} h atrás`
          : `${Math.floor(diff / 86400)} d atrás`;
  return `${d.toLocaleString("pt-BR")} (${rel})`;
}

export default function FarmTopologyDiagram({ farmId, pumps }: Props) {
  const [nodes, setNodes] = useState<Node[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Node | null>(null);

  useEffect(() => {
    let alive = true;
    if (!farmId) { setNodes([]); setLoading(false); return; }
    setLoading(true);
    (async () => {
      const { data } = await getSupabaseForFarm(farmId)
        .from("equipments")
        .select("id, name, type, alimenta_id, alimenta_alt_id")
        .eq("farm_id", farmId)
        .eq("active", true);
      if (!alive) return;
      setNodes(((data ?? []) as unknown as Node[]));
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [farmId]);

  const pumpById = useMemo(() => new Map(pumps.map(p => [p.id, p] as const)), [pumps]);

  const groups = useMemo(() => {
    const reservoirs = nodes.filter(n => n.type === "nivel").sort((a, b) => naturalSort(a.name, b.name));
    const wells = nodes.filter(n => n.type === "poco" || n.type === "bombeamento");
    return reservoirs.map(r => ({
      reservoir: r,
      wells: wells
        .filter(w => w.alimenta_id === r.id || w.alimenta_alt_id === r.id)
        .map(w => ({ node: w, shared: Boolean(w.alimenta_alt_id) }))
        .sort((a, b) => naturalSort(a.node.name, b.node.name)),
    }));
  }, [nodes]);

  const orphans = useMemo(
    () => nodes
      .filter(n => (n.type === "poco" || n.type === "bombeamento") && !n.alimenta_id && !n.alimenta_alt_id)
      .sort((a, b) => naturalSort(a.name, b.name)),
    [nodes],
  );

  const statusOf = (id: string) => {
    const p = pumpById.get(id);
    if (!p) return { label: "Sem dados", tone: "muted" as const, running: false, online: false, pump: undefined as Pump | undefined };
    if (!p.online) return { label: "Offline", tone: "muted" as const, running: false, online: false, pump: p };
    return p.running
      ? { label: "Ligado", tone: "on" as const, running: true, online: true, pump: p }
      : { label: "Desligado", tone: "off" as const, running: false, online: true, pump: p };
  };

  if (loading) {
    return <Card className="bg-card border-border"><CardContent className="p-6 text-sm text-muted-foreground">Carregando topologia…</CardContent></Card>;
  }
  if (groups.length === 0) {
    return <Card className="bg-card border-border"><CardContent className="p-6 text-sm text-muted-foreground">Nenhum reservatório cadastrado nesta fazenda.</CardContent></Card>;
  }

  return (
    <>
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Hierarquia Reservatório → Poços. Poços com borda tracejada abastecem dois reservatórios. Clique em um poço para ver o status.
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {groups.map(({ reservoir, wells }) => (
            <Card key={reservoir.id} className="bg-card border-2 border-primary/30 overflow-hidden">
              <CardHeader className="py-3 bg-primary/10 border-b border-primary/20">
                <CardTitle className="text-sm font-bold text-foreground flex items-center gap-2">
                  <Waves className="w-4 h-4 text-primary" />
                  {reservoir.name}
                  <Badge variant="secondary" className="ml-auto text-[10px]">{wells.length} poços</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {wells.map(({ node, shared }) => {
                    const st = statusOf(node.id);
                    return (
                      <button
                        key={node.id}
                        type="button"
                        onClick={() => setSelected(node)}
                        className={cn(
                          "rounded-md border p-2 text-left transition-colors hover:bg-accent/50",
                          shared ? "border-dashed border-2 border-warning" : "border-border",
                          st.tone === "on" && "bg-primary/10 border-primary/50",
                        )}
                      >
                        <div className="flex items-center gap-1.5">
                          <Droplets className={cn("w-3.5 h-3.5 shrink-0", st.tone === "on" ? "text-primary" : "text-muted-foreground")} />
                          <span className="text-xs font-medium text-foreground truncate">{node.name}</span>
                        </div>
                        <div className="flex items-center gap-1 mt-1">
                          <span className={cn(
                            "w-1.5 h-1.5 rounded-full",
                            st.tone === "on" ? "bg-primary" : st.tone === "off" ? "bg-destructive" : "bg-muted-foreground",
                          )} />
                          <span className="text-[10px] text-muted-foreground">{st.label}</span>
                          {shared && <Share2 className="w-3 h-3 text-warning ml-auto" />}
                        </div>
                      </button>
                    );
                  })}
                  {wells.length === 0 && (
                    <p className="text-xs text-muted-foreground col-span-full">Nenhum poço vinculado.</p>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {orphans.length > 0 && (
          <Card className="bg-card border-border">
            <CardHeader className="py-3"><CardTitle className="text-sm text-muted-foreground">Sem reservatório vinculado</CardTitle></CardHeader>
            <CardContent className="p-3 flex flex-wrap gap-2">
              {orphans.map(n => (
                <button key={n.id} type="button" onClick={() => setSelected(n)}
                  className="rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-accent/50">
                  {n.name}
                </button>
              ))}
            </CardContent>
          </Card>
        )}
      </div>

      <Dialog open={!!selected} onOpenChange={(o) => !o && setSelected(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-foreground">
              <Droplets className="w-4 h-4 text-primary" /> {selected?.name}
            </DialogTitle>
          </DialogHeader>
          {selected && (() => {
            const st = statusOf(selected.id);
            const res = nodes.find(n => n.id === selected.alimenta_id);
            const resAlt = nodes.find(n => n.id === selected.alimenta_alt_id);
            return (
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Status:</span>
                  <span className={cn("font-semibold", st.tone === "on" ? "text-primary" : st.tone === "off" ? "text-destructive" : "text-muted-foreground")}>
                    {st.label}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-muted-foreground" />
                  <span className="text-muted-foreground">Última comunicação:</span>
                  <span className="text-foreground">{formatWhen(st.pump?.lastCommunication)}</span>
                </div>
                {typeof st.pump?.signalRF === "number" && (
                  <div className="flex items-center gap-2">
                    <Radio className="w-4 h-4 text-muted-foreground" />
                    <span className="text-muted-foreground">Sinal RF:</span>
                    <span className="text-foreground">{st.pump.signalRF}%</span>
                  </div>
                )}
                <div className="flex items-start gap-2">
                  <Waves className="w-4 h-4 text-muted-foreground mt-0.5" />
                  <span className="text-muted-foreground">Abastece:</span>
                  <span className="text-foreground">
                    {[res?.name, resAlt?.name].filter(Boolean).join(" ou ") || "não definido"}
                  </span>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
    </>
  );
}
