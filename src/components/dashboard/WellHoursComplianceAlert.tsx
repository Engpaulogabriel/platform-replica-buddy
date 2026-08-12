// Alerta preventivo de compliance de horas (outorga INEMA). Compara as horas
// operadas HOJE de cada poço com o limite diário de horas da outorga
// (regime_hours_per_day). ≥80% → aviso amarelo; ≥100% → alerta vermelho ("desligue
// para evitar infração"). O objetivo é o operador PARAR antes de exceder — não
// esconder o excesso depois. Só o painel visual; a notificação WhatsApp é backend.
import { useEffect, useMemo, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AlertTriangle, Ban } from "lucide-react";

interface Props { farmId: string | null }

interface PumpHours { id: string; name: string; hours: number; limit: number; pct: number }

const todayStartIso = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); };
// Primeiro número do texto ("Poço 3" → 3; "POÇO 03 R2" → 3). NÃO concatena todos
// os dígitos (senão "POÇO 03 R2" viraria 32 e não casaria com "Poço 3").
const firstNum = (s: string) => { const m = String(s ?? "").match(/\d+/); return m ? parseInt(m[0], 10) : NaN; };
const fmtH = (h: number) => `${h.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}h`;

export function WellHoursComplianceAlert({ farmId }: Props) {
  const [pumps, setPumps] = useState<PumpHours[]>([]);

  const load = useCallback(async () => {
    if (!farmId) { setPumps([]); return; }
    const now = new Date().toISOString();
    const [{ data: permitRows }, { data: horas }] = await Promise.all([
      supabase.from("water_permits" as any).select("id, regime_hours_per_day").eq("farm_id", farmId),
      supabase.rpc("get_horimetro_daily", { _farm_id: farmId, _from: todayStartIso(), _to: now }),
    ]);
    const permits = (permitRows ?? []) as any[];
    if (permits.length === 0) { setPumps([]); return; }

    // Limite diário de horas por equipamento: vínculo explícito do poço
    // (water_permit_wells.equipment_id) ou casamento pelo nº no nome.
    let wells: any[] = [];
    const { data: ww } = await supabase.from("water_permit_wells" as any)
      .select("permit_id, equipment_id, well_name").in("permit_id", permits.map((p) => p.id));
    wells = (ww ?? []) as any[];
    const regimeByPermit = new Map<string, number>(permits.map((p) => [p.id as string, Number(p.regime_hours_per_day ?? 18) || 18]));
    const limitByEq = new Map<string, number>();
    const limitByNum = new Map<number, number>();
    for (const w of wells) {
      const hrs = regimeByPermit.get(w.permit_id) ?? 18;
      if (w.equipment_id && !limitByEq.has(w.equipment_id)) limitByEq.set(w.equipment_id, hrs);
      const n = firstNum(w.well_name ?? "");
      if (Number.isFinite(n) && !limitByNum.has(n)) limitByNum.set(n, hrs);
    }

    const hoursByEq = new Map<string, { name: string; hours: number }>();
    for (const r of (horas ?? []) as Array<{ equipment_id: string; equipment_name: string; hours: number }>) {
      const cur = hoursByEq.get(r.equipment_id) ?? { name: r.equipment_name, hours: 0 };
      cur.hours += Number(r.hours || 0);
      hoursByEq.set(r.equipment_id, cur);
    }

    const out: PumpHours[] = [];
    for (const [eqId, v] of hoursByEq) {
      let limit = limitByEq.get(eqId);
      if (limit == null) { const n = firstNum(v.name); if (Number.isFinite(n)) limit = limitByNum.get(n); }
      if (limit == null || limit <= 0) continue; // sem outorga vinculada → não avalia
      const pct = v.hours / limit;
      if (pct >= 0.8) out.push({ id: eqId, name: v.name, hours: Math.round(v.hours * 100) / 100, limit, pct });
    }
    out.sort((a, b) => b.pct - a.pct);
    setPumps(out);
  }, [farmId]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5 * 60_000); // revalida a cada 5 min
    return () => clearInterval(t);
  }, [load]);

  const over = useMemo(() => pumps.filter((p) => p.pct >= 1), [pumps]);
  const near = useMemo(() => pumps.filter((p) => p.pct >= 0.8 && p.pct < 1), [pumps]);

  if (over.length === 0 && near.length === 0) return null;

  return (
    <div className="space-y-2">
      {over.length > 0 && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2">
          <div className="flex items-center gap-2 text-sm font-bold text-destructive">
            <Ban className="w-4 h-4 shrink-0" />
            Limite diário da outorga atingido — desligue para evitar infração
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {over.map((p) => (
              <span key={p.id} className="text-xs font-semibold px-2 py-0.5 rounded-full bg-destructive/20 text-destructive border border-destructive/40">
                {p.name}: {fmtH(p.hours)} / {fmtH(p.limit)} ({Math.round(p.pct * 100)}%)
              </span>
            ))}
          </div>
        </div>
      )}
      {near.length > 0 && (
        <div className="rounded-lg border border-warning/50 bg-warning/10 px-3 py-2">
          <div className="flex items-center gap-2 text-sm font-bold text-warning">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            Poços se aproximando do limite diário de horas (≥80%)
          </div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {near.map((p) => (
              <span key={p.id} className="text-xs font-semibold px-2 py-0.5 rounded-full bg-warning/20 text-warning border border-warning/40">
                {p.name}: {fmtH(p.hours)} / {fmtH(p.limit)} ({Math.round(p.pct * 100)}%)
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
