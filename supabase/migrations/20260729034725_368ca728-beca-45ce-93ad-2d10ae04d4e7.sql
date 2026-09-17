CREATE OR REPLACE FUNCTION public.inema_snapshot(_farm_id uuid)
RETURNS TABLE(farm_id uuid, equipment_id uuid, equipment_name text,
              hours numeric, hours_limit numeric, volume_m3 numeric,
              volume_limit numeric, peak_pct numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $fn$
#variable_conflict use_column
DECLARE
  v_today date := (now() AT TIME ZONE 'America/Bahia')::date;
  v_day_start timestamptz := (v_today::timestamp AT TIME ZONE 'America/Bahia');
  v_day_end   timestamptz := ((v_today + 1)::timestamp AT TIME ZONE 'America/Bahia');
  r record; v_hours numeric; v_vol numeric; v_vol_src text; v_hpct numeric; v_vpct numeric; v_peak numeric; v_status text;
BEGIN
  IF NOT public.has_farm_access(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;
  FOR r IN
    SELECT p.equipment_id, p.farm_id, p.max_daily_hours, p.max_daily_volume_m3,
           e.name AS eq_name, e.estimated_flow_m3h, e.flow_total_m3, e.flow_daily_start_m3
    FROM public.inema_permits p JOIN public.equipments e ON e.id = p.equipment_id
    WHERE p.farm_id = _farm_id
  LOOP
    SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (
             LEAST(COALESCE(rt.ended_at,
                     CASE WHEN e2.last_communication > now() - interval '60 seconds' THEN now()
                          ELSE COALESCE(e2.last_communication, rt.started_at) END), v_day_end)
             - GREATEST(rt.started_at, v_day_start))) / 3600.0), 0)
      INTO v_hours
      FROM public.pump_runtime rt JOIN public.equipments e2 ON e2.id = rt.equipment_id
     WHERE rt.equipment_id = r.equipment_id AND rt.started_at < v_day_end
       AND COALESCE(rt.ended_at, now()) > v_day_start;
    v_hours := round(GREATEST(v_hours, 0)::numeric, 2);
    IF r.flow_total_m3 IS NOT NULL AND r.flow_daily_start_m3 IS NOT NULL
       AND (r.flow_total_m3 - r.flow_daily_start_m3) >= 0 THEN
      v_vol := round(r.flow_total_m3 - r.flow_daily_start_m3); v_vol_src := 'telemetria';
    ELSIF r.estimated_flow_m3h IS NOT NULL THEN
      v_vol := round(v_hours * r.estimated_flow_m3h); v_vol_src := 'estimado';
    ELSE v_vol := NULL; v_vol_src := '—'; END IF;
    v_hpct := CASE WHEN COALESCE(r.max_daily_hours,0) > 0 THEN round(v_hours / r.max_daily_hours * 100, 1) END;
    v_vpct := CASE WHEN COALESCE(r.max_daily_volume_m3,0) > 0 AND v_vol IS NOT NULL THEN round(v_vol / r.max_daily_volume_m3 * 100, 1) END;
    v_peak := GREATEST(COALESCE(v_hpct,0), COALESCE(v_vpct,0));
    v_status := CASE WHEN v_peak >= 95 THEN 'over' WHEN v_peak >= 80 THEN 'warn' ELSE 'ok' END;
    INSERT INTO public.inema_daily_compliance
      (farm_id, equipment_id, equipment_name, day, hours, hours_limit, hours_pct,
       volume_m3, volume_limit, volume_pct, volume_source, peak_pct, status, updated_at)
    VALUES
      (r.farm_id, r.equipment_id, r.eq_name, v_today, v_hours, r.max_daily_hours, v_hpct,
       v_vol, r.max_daily_volume_m3, v_vpct, v_vol_src, v_peak, v_status, now())
    ON CONFLICT (equipment_id, day) DO UPDATE SET
      hours=EXCLUDED.hours, hours_limit=EXCLUDED.hours_limit, hours_pct=EXCLUDED.hours_pct,
      volume_m3=EXCLUDED.volume_m3, volume_limit=EXCLUDED.volume_limit, volume_pct=EXCLUDED.volume_pct,
      volume_source=EXCLUDED.volume_source, peak_pct=EXCLUDED.peak_pct, status=EXCLUDED.status,
      equipment_name=EXCLUDED.equipment_name, updated_at=now();
  END LOOP;
  INSERT INTO public.system_alerts (severity, source, title, details)
  SELECT 'warning', 'inema-compliance', '⚠️ Poço próximo do limite INEMA',
         jsonb_build_object('equipment', c.equipment_name, 'farm_id', c.farm_id, 'day', c.day,
                            'hours', c.hours, 'peak_pct', c.peak_pct)
  FROM public.inema_daily_compliance c
  WHERE c.farm_id = _farm_id AND c.day = v_today AND c.peak_pct >= 95 AND c.alerted = false;
  RETURN QUERY
    SELECT c.farm_id, c.equipment_id, c.equipment_name, c.hours, c.hours_limit,
           c.volume_m3, c.volume_limit, c.peak_pct
    FROM public.inema_daily_compliance c
    WHERE c.farm_id = _farm_id AND c.day = v_today AND c.peak_pct >= 95 AND c.alerted = false;
  DELETE FROM public.inema_daily_compliance WHERE day < v_today - 400;
END
$fn$;