// Seletor de período compartilhado pelos Indicadores Gerenciais.
// Default: últimos 30 dias. Botão "Desde o início" busca a primeira data
// com dados na fazenda (automation_log ou equipments.created_at).
import { useEffect, useState } from "react";
import { CalendarRange } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";

export interface PeriodRange {
  fromIso: string; // YYYY-MM-DD
  toIso: string;   // YYYY-MM-DD
}

export interface PumpOption {
  id: string;
  name: string;
}

interface Props {
  farmId: string | null;
  value: PeriodRange;
  onChange: (next: PeriodRange) => void;
  pumpFilter: string; // "all" ou equipment id
  onPumpChange: (id: string) => void;
  pumps: PumpOption[];
}

const todayIso = () => new Date().toISOString().slice(0, 10);
const daysAgoIso = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};

export function PeriodPicker({ farmId, value, onChange, pumpFilter, onPumpChange, pumps }: Props) {
  const [loadingAll, setLoadingAll] = useState(false);

  const setPreset = (n: number) => {
    onChange({ fromIso: daysAgoIso(n), toIso: todayIso() });
  };

  const loadSinceStart = async () => {
    if (!farmId) return;
    setLoadingAll(true);
    try {
      const [logRes, eqRes] = await Promise.all([
        supabase.from("automation_log").select("occurred_at").eq("farm_id", farmId).order("occurred_at", { ascending: true }).limit(1),
        supabase.from("equipments").select("created_at").eq("farm_id", farmId).order("created_at", { ascending: true }).limit(1),
      ]);
      const first =
        (logRes.data?.[0] as { occurred_at?: string } | undefined)?.occurred_at ||
        (eqRes.data?.[0] as { created_at?: string } | undefined)?.created_at;
      const fromIso = first ? new Date(first).toISOString().slice(0, 10) : daysAgoIso(365);
      onChange({ fromIso, toIso: todayIso() });
    } finally {
      setLoadingAll(false);
    }
  };

  return (
    <div className="flex flex-wrap items-end gap-3 p-3 rounded-lg border border-border bg-card/60">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <CalendarRange className="w-4 h-4 text-primary" />
        Período
      </div>
      <div>
        <label className="text-[10px] uppercase text-muted-foreground block">Início</label>
        <Input type="date" value={value.fromIso} max={value.toIso}
          onChange={(e) => onChange({ ...value, fromIso: e.target.value })}
          className="bg-secondary border-border w-40" />
      </div>
      <div>
        <label className="text-[10px] uppercase text-muted-foreground block">Fim</label>
        <Input type="date" value={value.toIso} min={value.fromIso} max={todayIso()}
          onChange={(e) => onChange({ ...value, toIso: e.target.value })}
          className="bg-secondary border-border w-40" />
      </div>
      <div className="flex gap-1">
        <Button variant="outline" size="sm" className="h-9" onClick={() => setPreset(7)}>7d</Button>
        <Button variant="outline" size="sm" className="h-9" onClick={() => setPreset(30)}>30d</Button>
        <Button variant="outline" size="sm" className="h-9" onClick={() => setPreset(90)}>90d</Button>
        <Button variant="outline" size="sm" className="h-9" onClick={() => setPreset(365)}>12m</Button>
        <Button variant="default" size="sm" className="h-9" disabled={loadingAll} onClick={loadSinceStart}>
          {loadingAll ? "..." : "Desde o início"}
        </Button>
      </div>
      {pumps.length > 0 && (
        <div className="min-w-[180px]">
          <label className="text-[10px] uppercase text-muted-foreground block">Equipamento</label>
          <Select value={pumpFilter} onValueChange={onPumpChange}>
            <SelectTrigger className="bg-secondary border-border h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Todos</SelectItem>
              {pumps.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}

export const defaultPeriodRange = (): PeriodRange => ({
  fromIso: daysAgoIso(30),
  toIso: todayIso(),
});
