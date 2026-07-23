import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface LevelHistoryPoint {
  read_at: string;
  percent: number | null;
  meters: number | null;
  raw: number | null;
  is_calibrated: boolean;
}

export function useLevelHistory(
  equipmentId: string | null,
  from: Date,
  to: Date,
  enabled = true,
) {
  const [data, setData] = useState<LevelHistoryPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fromTime = from.getTime();
  const toTime = to.getTime();

  useEffect(() => {
    if (!enabled || !equipmentId) {
      setData([]);
      setLoading(false);
      setHasLoaded(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setHasLoaded(false);
    setError(null);
    (async () => {
      const { data: rows, error } = await supabase
        .from("level_history")
        .select("read_at, percent, meters, raw, is_calibrated")
        .eq("equipment_id", equipmentId)
        .gte("read_at", new Date(fromTime).toISOString())
        .lte("read_at", new Date(toTime).toISOString())
        .order("read_at", { ascending: true })
        .limit(200);
      if (cancelled) return;
      if (error) {
        setError(error.message);
        setData([]);
      } else {
        setData(
          (rows ?? []).map((r) => ({
            read_at: r.read_at as string,
            percent: r.percent != null ? Number(r.percent) : null,
            meters: r.meters != null ? Number(r.meters) : null,
            raw: r.raw,
            is_calibrated: !!r.is_calibrated,
          })),
        );
      }
      setHasLoaded(true);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [equipmentId, enabled, fromTime, toTime]);

  return { data, loading, hasLoaded, error };
}
