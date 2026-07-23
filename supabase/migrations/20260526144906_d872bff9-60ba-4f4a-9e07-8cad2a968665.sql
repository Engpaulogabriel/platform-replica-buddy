
-- ============================================================
-- Horímetro: pausa quando equipamento está offline
-- Para sessões abertas (ended_at IS NULL):
--   • Online (last_communication > now() - 60s): conta até now()
--   • Offline: conta só até last_communication (congela o relógio)
-- Quando o RX voltar, last_communication avança e o tempo retoma.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_horimetro_daily(_farm_id uuid, _from timestamp with time zone, _to timestamp with time zone)
 RETURNS TABLE(equipment_id uuid, equipment_name text, day date, hours numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.has_farm_access(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  RETURN QUERY
  WITH sessions AS (
    SELECT
      r.equipment_id,
      e.name AS equipment_name,
      r.started_at,
      CASE
        WHEN r.ended_at IS NOT NULL THEN r.ended_at
        WHEN e.last_communication IS NOT NULL
             AND e.last_communication > now() - interval '60 seconds'
          THEN now()
        ELSE COALESCE(e.last_communication, r.started_at)
      END AS effective_end
    FROM public.pump_runtime r
    JOIN public.equipments e ON e.id = r.equipment_id
    WHERE r.farm_id = _farm_id
  ),
  expanded AS (
    SELECT
      s.equipment_id,
      s.equipment_name,
      gs::date AS day,
      EXTRACT(EPOCH FROM (
        LEAST(s.effective_end, gs + interval '1 day', _to)
        - GREATEST(s.started_at, gs, _from)
      ))::numeric AS seconds_in_day
    FROM sessions s
    CROSS JOIN LATERAL generate_series(
      GREATEST(date_trunc('day', s.started_at), date_trunc('day', _from)),
      LEAST(date_trunc('day', s.effective_end), date_trunc('day', _to)),
      interval '1 day'
    ) AS gs
    WHERE s.started_at < _to
      AND s.effective_end > _from
      AND s.effective_end > s.started_at
  )
  SELECT
    expanded.equipment_id,
    expanded.equipment_name,
    expanded.day,
    ROUND(SUM(GREATEST(0, expanded.seconds_in_day)) / 3600.0, 2) AS hours
  FROM expanded
  GROUP BY expanded.equipment_id, expanded.equipment_name, expanded.day
  ORDER BY expanded.day, expanded.equipment_name;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_horimetro_month_total(_farm_id uuid, _equipment_id uuid)
 RETURNS numeric
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_total numeric;
  v_month_start timestamptz := date_trunc('month', now());
BEGIN
  IF NOT public.has_farm_access(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  SELECT COALESCE(
    SUM(
      EXTRACT(EPOCH FROM (
        CASE
          WHEN r.ended_at IS NOT NULL THEN r.ended_at
          WHEN e.last_communication IS NOT NULL
               AND e.last_communication > now() - interval '60 seconds'
            THEN now()
          ELSE COALESCE(e.last_communication, r.started_at)
        END
        - GREATEST(r.started_at, v_month_start)
      ))
    ) / 3600.0,
    0
  )
  INTO v_total
  FROM public.pump_runtime r
  JOIN public.equipments e ON e.id = r.equipment_id
  WHERE r.farm_id = _farm_id
    AND r.equipment_id = _equipment_id
    AND r.started_at < now()
    AND (
      r.ended_at IS NULL
      OR r.ended_at > v_month_start
    );

  RETURN ROUND(v_total, 2);
END;
$function$;
