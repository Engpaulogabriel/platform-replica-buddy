DO $$
DECLARE
  d date;
BEGIN
  FOR d IN SELECT (CURRENT_DATE - i)::date FROM generate_series(0, 30) i LOOP
    PERFORM public.compute_all_energy_efficiency(d);
  END LOOP;
END $$;