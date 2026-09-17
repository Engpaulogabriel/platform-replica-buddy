CREATE TABLE IF NOT EXISTS public.automation_log_cleanup_report (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          uuid NOT NULL,
  run_at          timestamptz NOT NULL DEFAULT now(),
  batch_order     int  NOT NULL,
  farm_id         uuid NOT NULL,
  farm_name       text,
  equipment_id    uuid,
  equipment_name  text,
  before_count    int NOT NULL,
  removed_not_confirmed int NOT NULL DEFAULT 0,
  removed_reading       int NOT NULL DEFAULT 0,
  removed_no_equipment  int NOT NULL DEFAULT 0,
  removed_repeated      int NOT NULL DEFAULT 0,
  removed_total   int NOT NULL DEFAULT 0,
  after_count     int NOT NULL
);

GRANT SELECT ON public.automation_log_cleanup_report TO authenticated;
GRANT ALL ON public.automation_log_cleanup_report TO service_role;

CREATE INDEX IF NOT EXISTS idx_alcr_run ON public.automation_log_cleanup_report (run_id, batch_order, farm_name);

ALTER TABLE public.automation_log_cleanup_report ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS alcr_select ON public.automation_log_cleanup_report;
CREATE POLICY alcr_select ON public.automation_log_cleanup_report
  FOR SELECT TO authenticated USING (public.has_farm_access(auth.uid(), farm_id));

CREATE OR REPLACE FUNCTION public.cleanup_automation_log_farm(_farm_id uuid, _run_id uuid, _batch_order int DEFAULT 9)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_marked int := 0;
  v_n int := 0;
  v_farm_name text;
BEGIN
  SELECT name INTO v_farm_name FROM public.farms WHERE id = _farm_id;

  DROP TABLE IF EXISTS _before;
  CREATE TEMP TABLE _before ON COMMIT DROP AS
  SELECT equipment_id, equipment_name, count(*)::int AS n
    FROM public.automation_log
   WHERE farm_id = _farm_id
     AND action IN ('turn_on','turn_off','pump_on','pump_off')
     AND noise_reason IS NULL
   GROUP BY equipment_id, equipment_name;

  UPDATE public.automation_log
     SET noise_reason = CASE
           WHEN equipment_id IS NULL                            THEN 'no_equipment'
           WHEN origin = 'reading'::public.event_origin         THEN 'reading_origin'
           ELSE 'not_confirmed'
         END
   WHERE farm_id = _farm_id
     AND action IN ('turn_on','turn_off','pump_on','pump_off')
     AND noise_reason IS NULL
     AND ( equipment_id IS NULL
        OR origin = 'reading'::public.event_origin
        OR result IS DISTINCT FROM 'success'::public.event_result );
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_marked := v_marked + v_n;

  WITH ordered AS (
    SELECT id,
           equipment_id,
           CASE WHEN action IN ('turn_on','pump_on') THEN 1 ELSE 0 END AS st,
           lag(CASE WHEN action IN ('turn_on','pump_on') THEN 1 ELSE 0 END)
             OVER (PARTITION BY equipment_id ORDER BY occurred_at, created_at, id) AS prev_st
      FROM public.automation_log
     WHERE farm_id = _farm_id
       AND action IN ('turn_on','turn_off','pump_on','pump_off')
       AND noise_reason IS NULL
       AND equipment_id IS NOT NULL
  )
  UPDATE public.automation_log al
     SET noise_reason = 'repeated_state'
    FROM ordered o
   WHERE al.id = o.id
     AND o.st = COALESCE(o.prev_st, 0);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  v_marked := v_marked + v_n;

  INSERT INTO public.automation_log_cleanup_report (
    run_id, batch_order, farm_id, farm_name, equipment_id, equipment_name,
    before_count, removed_not_confirmed, removed_reading, removed_no_equipment,
    removed_repeated, removed_total, after_count)
  SELECT
    _run_id, _batch_order, _farm_id, v_farm_name, b.equipment_id, b.equipment_name,
    b.n,
    COALESCE(m.not_confirmed, 0), COALESCE(m.reading, 0), COALESCE(m.no_equip, 0),
    COALESCE(m.repeated, 0),
    COALESCE(m.not_confirmed, 0) + COALESCE(m.reading, 0) + COALESCE(m.no_equip, 0) + COALESCE(m.repeated, 0),
    b.n - (COALESCE(m.not_confirmed, 0) + COALESCE(m.reading, 0) + COALESCE(m.no_equip, 0) + COALESCE(m.repeated, 0))
  FROM _before b
  LEFT JOIN (
    SELECT equipment_id,
           count(*) FILTER (WHERE noise_reason = 'not_confirmed')::int  AS not_confirmed,
           count(*) FILTER (WHERE noise_reason = 'reading_origin')::int AS reading,
           count(*) FILTER (WHERE noise_reason = 'no_equipment')::int   AS no_equip,
           count(*) FILTER (WHERE noise_reason = 'repeated_state')::int AS repeated
      FROM public.automation_log
     WHERE farm_id = _farm_id
       AND action IN ('turn_on','turn_off','pump_on','pump_off')
       AND noise_reason IS NOT NULL
     GROUP BY equipment_id
  ) m ON m.equipment_id IS NOT DISTINCT FROM b.equipment_id;

  DROP TABLE IF EXISTS _before;
  RETURN v_marked;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_automation_log_farm(uuid, uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_automation_log_farm(uuid, uuid, int) TO service_role;

DO $$
DECLARE
  v_run uuid := gen_random_uuid();
  r record;
BEGIN
  FOR r IN
    SELECT id, name,
           CASE WHEN name ILIKE '%perola%' OR name ILIKE '%pérola%' THEN 1
                WHEN name ILIKE '%sossego%' THEN 2
                WHEN name ILIKE '%semear%'  THEN 3
                ELSE 9 END AS ord
      FROM public.farms
     ORDER BY ord, name
  LOOP
    PERFORM public.cleanup_automation_log_farm(r.id, v_run, r.ord);
  END LOOP;

  RAISE NOTICE 'Limpeza concluída. run_id = % — consulte public.automation_log_cleanup_report.', v_run;
END $$;

WITH last_ok AS (
  SELECT DISTINCT ON (equipment_id) equipment_id, action
    FROM public.automation_log
   WHERE equipment_id IS NOT NULL
     AND noise_reason IS NULL
     AND action IN ('turn_on','turn_off','pump_on','pump_off')
   ORDER BY equipment_id, occurred_at DESC, created_at DESC, id DESC
)
UPDATE public.equipments e
   SET last_confirmed_state = CASE WHEN last_ok.action IN ('turn_on','pump_on') THEN 1 ELSE 0 END
  FROM last_ok
 WHERE e.id = last_ok.equipment_id;