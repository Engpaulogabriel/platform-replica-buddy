
-- 1) Equipment maintenance fields
ALTER TABLE public.equipments
  ADD COLUMN IF NOT EXISTS maintenance_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS maintenance_reason text,
  ADD COLUMN IF NOT EXISTS maintenance_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS maintenance_started_by text,
  ADD COLUMN IF NOT EXISTS maintenance_started_via text;

-- 2) Trigger: prevent turning equipment ON while in maintenance mode.
CREATE OR REPLACE FUNCTION public.enforce_maintenance_lock()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- If maintenance is being released in the same update, allow whatever else changes.
  IF NEW.maintenance_mode = false AND COALESCE(OLD.maintenance_mode, false) = true THEN
    RETURN NEW;
  END IF;

  -- Block ANY attempt to set desired_running=true while in maintenance.
  IF NEW.maintenance_mode = true AND NEW.desired_running = true
     AND (OLD.desired_running IS DISTINCT FROM NEW.desired_running OR OLD.maintenance_mode IS DISTINCT FROM NEW.maintenance_mode) THEN
    RAISE EXCEPTION 'Equipamento "%" está em MANUTENÇÃO — não é possível ligar.', NEW.name
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_maintenance_lock ON public.equipments;
CREATE TRIGGER trg_enforce_maintenance_lock
BEFORE UPDATE ON public.equipments
FOR EACH ROW
EXECUTE FUNCTION public.enforce_maintenance_lock();

-- 3) Patch run_automation_tick: skip ON when in maintenance, log skipped.
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
           e.plc_group_id, e.type AS eq_type, e.maintenance_mode AS eq_maint, f.timezone,
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

    -- MAINTENANCE GUARD: skip ON when equipment is locked.
    IF v_fire_on AND COALESCE(v_sched.eq_maint, false) = true THEN
      UPDATE public.automation_schedules SET last_on_executed_at = v_now WHERE id = v_sched.id;
      INSERT INTO public.automation_execution_log
        (schedule_id, equipment_id, farm_id, action, scheduled_time, executed_at, status, origin, details)
      VALUES (v_sched.id, v_sched.equipment_id, v_sched.farm_id, 'liga', v_effective_on, v_now, 'skipped', 'automatico',
              jsonb_build_object('reason','maintenance'));
      v_fire_on := false;
    END IF;

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
              jsonb_build_object('reason','already_stopped'));
    END IF;
  END LOOP;

  enqueued_count := v_enqueued;
  schedules_evaluated := v_evaluated;
  RETURN NEXT;
END;
$function$;

-- 4) WhatsApp conversational state: pending maintenance lock awaiting reason/confirmation.
CREATE TABLE IF NOT EXISTS public.whatsapp_maintenance_pending (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_phone text NOT NULL,
  equipment_id uuid NOT NULL REFERENCES public.equipments(id) ON DELETE CASCADE,
  equipment_name text NOT NULL,
  farm_id uuid REFERENCES public.farms(id) ON DELETE CASCADE,
  operator_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '2 minutes')
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.whatsapp_maintenance_pending TO authenticated;
GRANT ALL ON public.whatsapp_maintenance_pending TO service_role;

ALTER TABLE public.whatsapp_maintenance_pending ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_all_wa_maint_pending"
ON public.whatsapp_maintenance_pending FOR ALL
TO service_role
USING (true) WITH CHECK (true);
