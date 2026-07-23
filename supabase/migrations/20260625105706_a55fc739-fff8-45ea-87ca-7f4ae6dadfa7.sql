
-- 1. Add tracking columns to automation_schedules
ALTER TABLE public.automation_schedules
  ADD COLUMN IF NOT EXISTS created_by_name text,
  ADD COLUMN IF NOT EXISTS created_by_via text DEFAULT 'frontend',
  ADD COLUMN IF NOT EXISTS last_modified_by_name text,
  ADD COLUMN IF NOT EXISTS last_modified_by_via text;

-- 2. Execution log table
CREATE TABLE IF NOT EXISTS public.automation_execution_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid REFERENCES public.automation_schedules(id) ON DELETE SET NULL,
  equipment_id uuid REFERENCES public.equipments(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('liga','desliga')),
  scheduled_time text,
  executed_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'success' CHECK (status IN ('success','failed','expired','skipped')),
  origin text NOT NULL DEFAULT 'automatico',
  details jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aexec_farm_time ON public.automation_execution_log(farm_id, executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_aexec_equipment_time ON public.automation_execution_log(equipment_id, executed_at DESC);

GRANT SELECT ON public.automation_execution_log TO authenticated;
GRANT ALL ON public.automation_execution_log TO service_role;
ALTER TABLE public.automation_execution_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "aexec_select_members" ON public.automation_execution_log
  FOR SELECT TO authenticated USING (public.has_farm_access(auth.uid(), farm_id));
CREATE POLICY "aexec_service_all" ON public.automation_execution_log
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 3. Schedule audit table
CREATE TABLE IF NOT EXISTS public.automation_schedules_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid,
  equipment_id uuid,
  farm_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('created','updated','deleted','activated','deactivated')),
  performed_by text,
  performed_via text,
  old_values jsonb,
  new_values jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_aaudit_farm_time ON public.automation_schedules_audit(farm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_aaudit_equipment_time ON public.automation_schedules_audit(equipment_id, created_at DESC);

GRANT SELECT ON public.automation_schedules_audit TO authenticated;
GRANT ALL ON public.automation_schedules_audit TO service_role;
ALTER TABLE public.automation_schedules_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY "aaudit_select_members" ON public.automation_schedules_audit
  FOR SELECT TO authenticated USING (public.has_farm_access(auth.uid(), farm_id));
CREATE POLICY "aaudit_service_all" ON public.automation_schedules_audit
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- 4. Audit trigger
CREATE OR REPLACE FUNCTION public.fn_automation_schedules_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_action text;
  v_by text;
  v_via text;
  v_email text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'created';
    v_by := NEW.created_by_name;
    v_via := COALESCE(NEW.created_by_via, 'frontend');
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'deleted';
    v_by := OLD.last_modified_by_name;
    v_via := COALESCE(OLD.last_modified_by_via, 'frontend');
  ELSE
    IF NEW.active IS DISTINCT FROM OLD.active THEN
      v_action := CASE WHEN NEW.active THEN 'activated' ELSE 'deactivated' END;
    ELSE
      v_action := 'updated';
    END IF;
    v_by := NEW.last_modified_by_name;
    v_via := COALESCE(NEW.last_modified_by_via, 'frontend');
  END IF;

  -- Fallback: lookup auth user email when label missing
  IF v_by IS NULL THEN
    BEGIN
      SELECT email INTO v_email FROM auth.users WHERE id = auth.uid();
      v_by := v_email;
    EXCEPTION WHEN OTHERS THEN
      v_by := NULL;
    END;
  END IF;

  INSERT INTO public.automation_schedules_audit (
    schedule_id, equipment_id, farm_id, action, performed_by, performed_via, old_values, new_values
  ) VALUES (
    COALESCE(NEW.id, OLD.id),
    COALESCE(NEW.equipment_id, OLD.equipment_id),
    COALESCE(NEW.farm_id, OLD.farm_id),
    v_action,
    v_by,
    v_via,
    CASE WHEN TG_OP IN ('UPDATE','DELETE') THEN to_jsonb(OLD) END,
    CASE WHEN TG_OP IN ('INSERT','UPDATE') THEN to_jsonb(NEW) END
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_automation_schedules_audit ON public.automation_schedules;
CREATE TRIGGER trg_automation_schedules_audit
AFTER INSERT OR UPDATE OR DELETE ON public.automation_schedules
FOR EACH ROW EXECUTE FUNCTION public.fn_automation_schedules_audit();

-- 5. Update automation tick to log executions + tag origin
CREATE OR REPLACE FUNCTION public.run_automation_tick()
 RETURNS TABLE(enqueued_count integer, schedules_evaluated integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_enqueued int := 0;
  v_evaluated int := 0;
  v_sched RECORD;
  v_now timestamptz := now();
  v_local_now timestamp;
  v_today date;
  v_timezone text;
  v_dow_idx int;
  v_dow_key_pt text;
  v_dow_key_en text;
  v_dow_keys_pt text[] := ARRAY['dom','seg','ter','qua','qui','sex','sab'];
  v_dow_keys_en text[] := ARRAY['sun','mon','tue','wed','thu','fri','sat'];
  v_holiday_mmdd text;
  v_now_min int;
  v_on_min int;
  v_off_min int;
  v_currently_running boolean;
  v_holiday_cfg RECORD;
  v_effective_on text;
  v_effective_off text;
  v_tsnn text;
  v_plc_total int;
  v_frame text;
  v_lora text;
  v_payload text;
  v_radio text;
  v_via_rep boolean;
  v_new_cmd_id uuid;
  v_today_in_days boolean;
  v_fire_on boolean;
  v_fire_off boolean;
  v_last_on_local date;
  v_last_off_local date;
  v_holidays text[] := ARRAY['01-01','04-21','05-01','09-07','10-12','11-02','11-15','12-25'];
  WINDOW_MIN constant int := 2;
BEGIN
  PERFORM public.enqueue_turn_on_timeout_resets(NULL);
  DELETE FROM public.automation_fired WHERE fired_at < now() - interval '2 days';

  FOR v_sched IN
    SELECT s.*, e.farm_id AS eq_farm, e.hw_id, e.saida, e.last_outputs_state,
           e.pending_command_id, e.command_blocked_until,
           e.plc_group_id, e.type AS eq_type, f.timezone,
           COALESCE(pg.output_count, 1) AS plc_total,
           pg.hw_id AS plc_tsnn
    FROM public.automation_schedules s
    JOIN public.equipments e ON e.id = s.equipment_id
    JOIN public.farms f ON f.id = s.farm_id
    JOIN public.automation_engine ae ON ae.farm_id = s.farm_id AND ae.enabled = true
    LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
    WHERE s.active = true AND e.active = true AND e.type IN ('poco','bombeamento')
  LOOP
    v_evaluated := v_evaluated + 1;
    v_timezone := COALESCE(NULLIF(v_sched.timezone, ''), 'America/Sao_Paulo');
    v_local_now := v_now AT TIME ZONE v_timezone;
    v_today := v_local_now::date;
    v_dow_idx := EXTRACT(DOW FROM v_local_now)::int;
    v_dow_key_pt := v_dow_keys_pt[v_dow_idx + 1];
    v_dow_key_en := v_dow_keys_en[v_dow_idx + 1];
    v_holiday_mmdd := to_char(v_local_now, 'MM-DD');
    v_now_min := EXTRACT(HOUR FROM v_local_now)::int * 60 + EXTRACT(MINUTE FROM v_local_now)::int;

    v_effective_on := v_sched.time_on;
    v_effective_off := v_sched.time_off;

    IF v_holiday_mmdd = ANY(v_holidays) THEN
      SELECT * INTO v_holiday_cfg FROM public.automation_holiday_configs
      WHERE farm_id = v_sched.farm_id AND equipment_id = v_sched.equipment_id LIMIT 1;
      IF FOUND AND v_holiday_cfg.enabled THEN
        IF v_holiday_cfg.mode = 'free-demand' THEN CONTINUE; END IF;
        IF v_holiday_cfg.mode = 'special-schedule' THEN
          v_effective_on := COALESCE(v_holiday_cfg.special_time_on, v_effective_on);
          v_effective_off := COALESCE(v_holiday_cfg.special_time_off, v_effective_off);
        END IF;
      END IF;
    END IF;

    v_today_in_days := v_dow_key_pt = ANY(v_sched.days) OR v_dow_key_en = ANY(v_sched.days);
    IF NOT v_today_in_days THEN CONTINUE; END IF;

    v_on_min := NULL;
    v_off_min := NULL;
    IF v_effective_on ~ '^\d{2}:\d{2}' THEN
      v_on_min := (split_part(v_effective_on,':',1))::int * 60 + (split_part(v_effective_on,':',2))::int;
    END IF;
    IF v_effective_off ~ '^\d{2}:\d{2}' THEN
      v_off_min := (split_part(v_effective_off,':',1))::int * 60 + (split_part(v_effective_off,':',2))::int;
    END IF;

    v_last_on_local := CASE WHEN v_sched.last_on_executed_at IS NULL THEN NULL
                            ELSE (v_sched.last_on_executed_at AT TIME ZONE v_timezone)::date END;
    v_last_off_local := CASE WHEN v_sched.last_off_executed_at IS NULL THEN NULL
                             ELSE (v_sched.last_off_executed_at AT TIME ZONE v_timezone)::date END;

    v_fire_on := v_sched.mode <> 'off-only'
                 AND v_on_min IS NOT NULL
                 AND v_now_min >= v_on_min
                 AND v_now_min < v_on_min + WINDOW_MIN
                 AND (v_last_on_local IS NULL OR v_last_on_local <> v_today);

    v_fire_off := v_sched.mode <> 'on-only'
                  AND v_off_min IS NOT NULL
                  AND v_now_min >= v_off_min
                  AND v_now_min < v_off_min + WINDOW_MIN
                  AND (v_last_off_local IS NULL OR v_last_off_local <> v_today);

    IF NOT v_fire_on AND NOT v_fire_off THEN CONTINUE; END IF;

    IF v_sched.last_outputs_state ~ '^[01]{6}$' AND COALESCE(v_sched.saida,1) BETWEEN 1 AND 6 THEN
      v_currently_running := substring(v_sched.last_outputs_state from COALESCE(v_sched.saida,1)::int for 1) = '1';
    ELSIF v_sched.last_outputs_state ~ '^[01]$' THEN
      v_currently_running := v_sched.last_outputs_state = '1';
    ELSE
      v_currently_running := false;
    END IF;

    v_tsnn := COALESCE(v_sched.plc_tsnn, substring(v_sched.hw_id from 1 for 4));
    v_plc_total := COALESCE(v_sched.plc_total, 1);

    SELECT COALESCE(radio, 'R1'), COALESCE(via_repetidor, false)
      INTO v_radio, v_via_rep
    FROM public.rf_routing WHERE farm_id = v_sched.farm_id;
    IF v_radio IS NULL THEN v_radio := 'R1'; END IF;
    IF v_via_rep IS NULL THEN v_via_rep := false; END IF;

    IF v_fire_on
       AND v_currently_running = false
       AND v_sched.pending_command_id IS NULL
       AND (v_sched.command_blocked_until IS NULL OR v_sched.command_blocked_until <= v_now)
    THEN
      v_payload := public.renov_combined_payload(v_sched.last_outputs_state, COALESCE(v_sched.saida, 1), true, v_plc_total);
      v_lora := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';
      v_frame := CASE WHEN v_via_rep THEN 'REP:R3:TX:' || v_radio || ':' || v_lora ELSE v_lora END;

      INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device)
      VALUES (v_sched.farm_id, v_sched.equipment_id, v_tsnn, 'manual', 1, v_frame, 120000, 'cloud-automation')
      RETURNING id INTO v_new_cmd_id;

      UPDATE public.equipments
      SET pending_command_id = v_new_cmd_id,
          command_blocked_until = v_now + interval '120 seconds',
          desired_running = true,
          last_actuation_origin = 'automatico',
          updated_at = v_now
      WHERE id = v_sched.equipment_id AND pending_command_id IS NULL;

      UPDATE public.automation_schedules SET last_on_executed_at = v_now WHERE id = v_sched.id;

      INSERT INTO public.automation_execution_log
        (schedule_id, equipment_id, farm_id, action, scheduled_time, executed_at, status, origin, details)
      VALUES (v_sched.id, v_sched.equipment_id, v_sched.farm_id, 'liga', v_effective_on, v_now, 'success', 'automatico',
              jsonb_build_object('command_id', v_new_cmd_id));

      v_enqueued := v_enqueued + 1;

    ELSIF v_fire_on AND v_currently_running = true THEN
      UPDATE public.automation_schedules SET last_on_executed_at = v_now WHERE id = v_sched.id;
      INSERT INTO public.automation_execution_log
        (schedule_id, equipment_id, farm_id, action, scheduled_time, executed_at, status, origin, details)
      VALUES (v_sched.id, v_sched.equipment_id, v_sched.farm_id, 'liga', v_effective_on, v_now, 'skipped', 'automatico',
              jsonb_build_object('reason','already_running'));
    END IF;

    IF v_fire_off
       AND v_currently_running = true
       AND v_sched.pending_command_id IS NULL
       AND (v_sched.command_blocked_until IS NULL OR v_sched.command_blocked_until <= v_now)
    THEN
      v_payload := public.renov_combined_payload(v_sched.last_outputs_state, COALESCE(v_sched.saida, 1), false, v_plc_total);
      v_lora := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';
      v_frame := CASE WHEN v_via_rep THEN 'REP:R3:TX:' || v_radio || ':' || v_lora ELSE v_lora END;

      INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device)
      VALUES (v_sched.farm_id, v_sched.equipment_id, v_tsnn, 'manual', 1, v_frame, 120000, 'cloud-automation')
      RETURNING id INTO v_new_cmd_id;

      UPDATE public.equipments
      SET pending_command_id = v_new_cmd_id,
          command_blocked_until = v_now + interval '120 seconds',
          desired_running = false,
          last_actuation_origin = 'automatico',
          updated_at = v_now
      WHERE id = v_sched.equipment_id AND pending_command_id IS NULL;

      UPDATE public.automation_schedules SET last_off_executed_at = v_now WHERE id = v_sched.id;

      INSERT INTO public.automation_execution_log
        (schedule_id, equipment_id, farm_id, action, scheduled_time, executed_at, status, origin, details)
      VALUES (v_sched.id, v_sched.equipment_id, v_sched.farm_id, 'desliga', v_effective_off, v_now, 'success', 'automatico',
              jsonb_build_object('command_id', v_new_cmd_id));

      v_enqueued := v_enqueued + 1;

    ELSIF v_fire_off AND v_currently_running = false THEN
      UPDATE public.automation_schedules SET last_off_executed_at = v_now WHERE id = v_sched.id;
      INSERT INTO public.automation_execution_log
        (schedule_id, equipment_id, farm_id, action, scheduled_time, executed_at, status, origin, details)
      VALUES (v_sched.id, v_sched.equipment_id, v_sched.farm_id, 'desliga', v_effective_off, v_now, 'skipped', 'automatico',
              jsonb_build_object('reason','already_off'));
    END IF;
  END LOOP;

  INSERT INTO public.automation_tick_logs (schedules_found, commands_inserted, details)
  VALUES (v_evaluated, v_enqueued, jsonb_build_object('mode', 'single-fire-2min-window', 'version', 4));

  enqueued_count := v_enqueued;
  schedules_evaluated := v_evaluated;
  RETURN NEXT;
END;
$function$;
