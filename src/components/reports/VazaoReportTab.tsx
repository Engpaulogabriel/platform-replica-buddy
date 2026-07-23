import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Droplets, Loader2 } from "lucide-react";
import { BarChart, Bar, Cell, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { supabase } from "@/integrations/supabase/client";

interface VazaoReportTabProps {
  farmId: string | null;
  fromDate: string;
  toDate: string;
}

interface FlowEquip {
  id: string;
  name: string;
  flow_total_m3: number | null;
  flow_rate_m3h: number | null;
}

interface DailyRecord {
  equipment_id: string;
  date: string; // YYYY-MM-DD
  total_m3: number;
}

interface DailyPoint {
  day: string;
  label: string;
  consumo: number;
  isToday?: boolean;
}

interface DailyRow {
  key: string;
  day: string;
  label: string;
  equipmentId: string;
  equipmentName: string;
  consumo: number;
  vazaoMax: number;
  isPartial: boolean;
}

interface MonthlyPoint {
  month: string;
  label: string;
  consumo: number;
}

const fmt = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 0 });
const fmt1 = (n: number) => n.toLocaleString("pt-BR", { maximumFractionDigits: 1 });

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function labelDay(k: string): string {
  const [, m, d] = k.split("-");
  return `${d}/${m}`;
}

function labelMonth(k: string): string {
  const [y, m] = k.split("-");
  const meses = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
  return `${meses[Number(m) - 1]}/${y.slice(2)}`;
}

export default function VazaoReportTab({ farmId, fromDate, toDate }: VazaoReportTabProps) {
  const [equips, setEquips] = useState<FlowEquip[]>([]);
  const [allNames, setAllNames] = useState<Map<string, string>>(new Map());
  const [selectedEquip, setSelectedEquip] = useState<string>("all");
  const [daily, setDaily] = useState<DailyRecord[]>([]);
  const [flowMaxByDayEq, setFlowMaxByDayEq] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(false);

  // Equipamentos de vazão (para gráfico/parcial) — refresh a cada 30s para
  // manter o "parcial de hoje" acompanhando o flow_total_m3 corrente.
  useEffect(() => {
    if (!farmId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const { data } = await supabase
          .from("equipments")
          .select("id, name, type, vazao_mode, flow_total_m3, flow_rate_m3h")
          .eq("farm_id", farmId)
          .in("vazao_mode", ["real", "estimado"])
          .order("name")
          .throwOnError();
        if (cancelled) return;
        const rows = (data ?? []) as (FlowEquip & { type?: string; vazao_mode?: string })[];
        console.log("[VazaoReport] equipamentos:", rows);
        console.log("[VazaoReport] flow_total_m3 por eq:", rows.map(r => `${r.name}=${r.flow_total_m3} (${typeof r.flow_total_m3})`));
        setEquips(rows as FlowEquip[]);
      } catch (err) {
        console.error("[VazaoReport] erro ao carregar equipments:", err);
      }
    };
    void load();
    const id = window.setInterval(load, 30000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [farmId]);


  // Mapa completo de nomes da fazenda (para lookup no histórico, mesmo de
  // equipamentos que hoje não são mais 'vazao'/'real').
  useEffect(() => {
    if (!farmId) return;
    let cancelled = false;
    void supabase
      .from("equipments")
      .select("id,name")
      .eq("farm_id", farmId)
      .then(({ data }) => {
        if (cancelled) return;
        const m = new Map<string, string>();
        for (const r of (data ?? []) as { id: string; name: string }[]) m.set(r.id, r.name);
        setAllNames(m);
      });
    return () => { cancelled = true; };
  }, [farmId]);

  useEffect(() => {
    if (!farmId) return;
    let cancelled = false;
    setLoading(true);
    const from = new Date();
    from.setMonth(from.getMonth() - 12);
    from.setDate(1);
    const fromStr = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}-01`;
    void (async () => {
      let query = supabase
        .from("daily_consumption")
        .select("equipment_id,date,total_m3")
        .eq("farm_id", farmId)
        .gte("date", fromStr)
        .order("date", { ascending: true })
        .limit(20000);
      if (selectedEquip !== "all") query = query.eq("equipment_id", selectedEquip);
      const { data } = await query;
      if (cancelled) return;
      setDaily((data ?? []) as DailyRecord[]);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [farmId, selectedEquip]);

  // Vazão máxima por dia+equipamento no intervalo visível (últimos 30 dias
  // é o que a tabela mostra). Busca flow_history e reduz para MAX no cliente.
  useEffect(() => {
    if (!farmId || !fromDate || !toDate) return;
    let cancelled = false;
    void (async () => {
      const fromTs = `${fromDate}T00:00:00`;
      // toDate é inclusivo — pega até o fim do dia
      const toTs = `${toDate}T23:59:59.999`;
      let q = supabase
        .from("flow_history")
        .select("equipment_id,ts,flow_rate_m3h")
        .eq("farm_id", farmId)
        .gte("ts", fromTs)
        .lte("ts", toTs)
        .gt("flow_rate_m3h", 0)
        .limit(50000);
      if (selectedEquip !== "all") q = q.eq("equipment_id", selectedEquip);
      const { data } = await q;
      if (cancelled) return;
      const m = new Map<string, number>();
      for (const r of (data ?? []) as { equipment_id: string; ts: string; flow_rate_m3h: number | null }[]) {
        const day = String(r.ts).slice(0, 10);
        const key = `${day}__${r.equipment_id}`;
        const v = Number(r.flow_rate_m3h ?? 0);
        const cur = m.get(key) ?? 0;
        if (v > cur) m.set(key, v);
      }
      setFlowMaxByDayEq(m);
    })();
    return () => { cancelled = true; };
  }, [farmId, fromDate, toDate, selectedEquip]);

  const equipNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const [k, v] of allNames.entries()) m.set(k, v);
    for (const e of equips) m.set(e.id, e.name);
    return m;
  }, [equips, allNames]);

  // Equipamentos considerados no cálculo (respeita filtro)
  const activeEquips = useMemo(
    () => (selectedEquip === "all" ? equips : equips.filter((e) => e.id === selectedEquip)),
    [equips, selectedEquip],
  );

  const today = todayKey();

  // Total parcial de hoje (soma dos flow_total_m3 atuais dos equipamentos ativos)
  const partialToday = useMemo(
    () => {
      const total = activeEquips.reduce((acc, e) => acc + Number(e.flow_total_m3 ?? 0), 0);
      console.log("[VazaoReport] partialToday:", total, "m³ | activeEquips:",
        activeEquips.map(e => ({ name: e.name, flow_total_m3: e.flow_total_m3, raw: typeof e.flow_total_m3 })));
      return total;
    },
    [activeEquips],
  );


  // Agrega por dia (soma entre equipamentos) — inclui hoje como parcial
  const dailyAll = useMemo<DailyPoint[]>(() => {
    const map = new Map<string, number>();
    for (const r of daily) {
      if (r.date === today) continue; // hoje não vem do daily_consumption
      map.set(r.date, (map.get(r.date) ?? 0) + Number(r.total_m3 ?? 0));
    }
    // Sempre incluir o dia de hoje quando dentro da janela — mesmo com 0 m³ —
    // para que a barra apareça no gráfico com o rótulo "(parcial)".
    if (today >= fromDate && today <= toDate) {
      map.set(today, partialToday);
    }
    return [...map.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([day, consumo]) => ({ day, label: labelDay(day), consumo, isToday: day === today }));
  }, [daily, partialToday, today, fromDate, toDate]);

  const daily30 = useMemo<DailyPoint[]>(() => {
    return dailyAll.filter((p) => p.day >= fromDate && p.day <= toDate).slice(-30);
  }, [dailyAll, fromDate, toDate]);

  // Linhas da tabela por (dia, equipamento) + linha parcial de hoje
  const dailyRows = useMemo<DailyRow[]>(() => {
    const out: DailyRow[] = [];
    for (const r of daily) {
      if (r.date < fromDate || r.date > toDate) continue;
      if (r.date === today) continue;
      const key = `${r.date}__${r.equipment_id}`;
      out.push({
        key,
        day: r.date,
        label: labelDay(r.date),
        equipmentId: r.equipment_id,
        equipmentName: equipNameById.get(r.equipment_id) ?? "Desconhecido",
        consumo: Number(r.total_m3 ?? 0),
        vazaoMax: flowMaxByDayEq.get(key) ?? 0,
        isPartial: false,
      });
    }
    if (today >= fromDate && today <= toDate) {
      for (const e of activeEquips) {
        const v = Number(e.flow_total_m3 ?? 0);
        const key = `${today}__${e.id}`;
        const hist = flowMaxByDayEq.get(key) ?? 0;
        const currentRate = Number(e.flow_rate_m3h ?? 0);
        // Se não há histórico do dia, mostra a vazão instantânea atual.
        const vazaoMax = hist > 0 ? hist : currentRate;
        // Sempre inclui a linha do dia em curso para os equipamentos ativos.

        out.push({
          key,
          day: today,
          label: labelDay(today),
          equipmentId: e.id,
          equipmentName: e.name,
          consumo: v,
          vazaoMax,
          isPartial: true,
        });
      }
    }
    out.sort((a, b) => {
      if (a.day !== b.day) return a.day < b.day ? 1 : -1;
      return a.equipmentName.localeCompare(b.equipmentName, "pt-BR");
    });
    return out.slice(0, 30 * Math.max(1, activeEquips.length || 1));
  }, [daily, fromDate, toDate, equipNameById, activeEquips, today, flowMaxByDayEq]);

  const monthly12 = useMemo<MonthlyPoint[]>(() => {
    const map = new Map<string, number>();
    for (const r of daily) {
      if (r.date === today) continue;
      const mk = r.date.slice(0, 7);
      map.set(mk, (map.get(mk) ?? 0) + Number(r.total_m3 ?? 0));
    }
    // Soma o parcial de hoje ao mês corrente
    const currentMonth = today.slice(0, 7);
    if (partialToday > 0) {
      map.set(currentMonth, (map.get(currentMonth) ?? 0) + partialToday);
    }
    return [...map.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .slice(-12)
      .map(([month, consumo]) => ({ month, label: labelMonth(month), consumo }));
  }, [daily, partialToday, today]);

  const totalPeriodo = useMemo(
    () => daily30.reduce((acc, p) => acc + p.consumo, 0),
    [daily30],
  );

  const hasFlowData = equips.length > 0 || daily.length > 0;
  const showEmpty = !loading && !hasFlowData;
  const showNoData = !loading && hasFlowData && daily.length === 0 && partialToday === 0;

  return (
    <div className="space-y-4">
      {equips.length > 1 && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Equipamento:</span>
          <Select value={selectedEquip} onValueChange={setSelectedEquip}>
            <SelectTrigger className="h-8 w-56 bg-secondary border-border text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {equips.map((e) => <SelectItem key={e.id} value={e.id}>{e.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <span className="text-xs text-muted-foreground ml-auto">
            Total no período: <span className="font-bold text-foreground">{fmt(totalPeriodo)} m³</span>
          </span>
        </div>
      )}

      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base text-foreground">Consumo Diário (m³) — últimos 30 dias</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="h-[280px] flex items-center justify-center text-muted-foreground">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : showEmpty ? (
            <div className="h-[280px] flex flex-col items-center justify-center text-center gap-2 text-muted-foreground">
              <Droplets className="w-10 h-10 opacity-40" />
              <p className="text-sm font-medium">Nenhum sensor de vazão cadastrado</p>
              <p className="text-xs max-w-md">
                Cadastre um equipamento do tipo "Vazão/Consumo" ou ative o modo "Real" em um poço para começar a registrar consumo.
              </p>
            </div>
          ) : showNoData ? (
            <div className="h-[280px] flex items-center justify-center text-muted-foreground text-sm">
              Ainda sem leituras. Aguardando frames com totalizador do PLC.
            </div>
          ) : (
            <div className="h-[280px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={daily30}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 12 }}
                    formatter={(v: number, _n, p: { payload?: DailyPoint }) => [
                      `${fmt(v)} m³${p?.payload?.isToday ? " (parcial)" : ""}`,
                      "Consumo",
                    ]}
                  />
                  <Bar dataKey="consumo" radius={[4, 4, 0, 0]}>
                    {daily30.map((p) => (
                      <Cell
                        key={p.day}
                        fill="hsl(var(--primary))"
                        fillOpacity={p.isToday ? 0.5 : 1}
                      />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader className="pb-2">
          <CardTitle className="text-base text-foreground">Consumo Mensal (m³) — últimos 12 meses</CardTitle>
        </CardHeader>
        <CardContent>
          {loading || monthly12.length === 0 ? (
            <div className="h-[240px] flex items-center justify-center text-muted-foreground text-sm">
              {loading ? <Loader2 className="w-6 h-6 animate-spin" /> : "Sem dados suficientes"}
            </div>
          ) : (
            <div className="h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={monthly12}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 12 }}
                    formatter={(v: number) => [`${fmt(v)} m³`, "Consumo"]}
                  />
                  <Bar dataKey="consumo" fill="hsl(var(--info))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="bg-card border-border">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-foreground">Histórico Diário</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="border-border hover:bg-secondary/50">
                <TableHead className="text-muted-foreground">Data</TableHead>
                <TableHead className="text-muted-foreground">Equipamento</TableHead>
                <TableHead className="text-muted-foreground text-right">Consumo do dia (m³)</TableHead>
                <TableHead className="text-muted-foreground text-right">Vazão Máx. (m³/h)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dailyRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                    Sem dados no período selecionado.
                  </TableCell>
                </TableRow>
              ) : (
                dailyRows.map((p) => (
                  <TableRow key={p.key} className="border-border">
                    <TableCell className="text-foreground">
                      {p.label}
                      {p.isPartial && <span className="ml-2 text-[10px] text-muted-foreground">(parcial)</span>}
                    </TableCell>
                    <TableCell className="text-foreground">{p.equipmentName}</TableCell>
                    <TableCell className="text-right font-semibold text-primary">{fmt(p.consumo)}</TableCell>
                    <TableCell className="text-right text-foreground">
                      {p.vazaoMax > 0 ? fmt1(p.vazaoMax) : "—"}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
