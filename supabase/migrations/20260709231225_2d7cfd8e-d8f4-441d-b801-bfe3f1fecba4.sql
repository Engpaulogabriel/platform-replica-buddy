DO $migration$
DECLARE
  ddl text;
  new_ddl text;
BEGIN
  ddl := pg_get_functiondef('public.calculate_energy_efficiency_for_date(uuid,date)'::regprocedure);
  new_ddl := replace(
    ddl,
$old$
        ((_date::text || ' ' || peak_start_local::text)::timestamp AT TIME ZONE tz),
        ((_date::text || ' ' || peak_end_local::text)::timestamp AT TIME ZONE tz)
$old$,
$new$
        ((_date::text || ' ' || peak_start_local::text)::timestamp AT TIME ZONE tz),
        LEAST(((_date::text || ' ' || peak_end_local::text)::timestamp AT TIME ZONE tz), now())
$new$
  );

  IF new_ddl = ddl THEN
    RAISE EXCEPTION 'calculate_energy_efficiency_for_date peak clamp not replaced';
  END IF;

  EXECUTE new_ddl;
END;
$migration$;

DO $migration$
DECLARE
  ddl text;
  new_ddl text;
BEGIN
  ddl := pg_get_functiondef('public.calculate_energy_efficiency_pumps_for_date(uuid,date)'::regprocedure);
  new_ddl := replace(
    ddl,
$old$
        ((_date::text || ' ' || peak_start_local::text)::timestamp AT TIME ZONE tz),
        ((_date::text || ' ' || peak_end_local::text)::timestamp AT TIME ZONE tz)
$old$,
$new$
        ((_date::text || ' ' || peak_start_local::text)::timestamp AT TIME ZONE tz),
        LEAST(((_date::text || ' ' || peak_end_local::text)::timestamp AT TIME ZONE tz), now())
$new$
  );

  IF new_ddl = ddl THEN
    RAISE EXCEPTION 'calculate_energy_efficiency_pumps_for_date peak clamp not replaced';
  END IF;

  EXECUTE new_ddl;
END;
$migration$;

DO $recalc$
DECLARE
  farm_row record;
  recalc_date date;
BEGIN
  FOR farm_row IN SELECT id FROM public.farms LOOP
    FOR recalc_date IN
      SELECT generate_series((now() AT TIME ZONE 'America/Sao_Paulo')::date - 30, (now() AT TIME ZONE 'America/Sao_Paulo')::date, interval '1 day')::date
    LOOP
      PERFORM public.compute_energy_efficiency(farm_row.id, recalc_date);
    END LOOP;
  END LOOP;
END;
$recalc$;