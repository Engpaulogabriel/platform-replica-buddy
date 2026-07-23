
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
  v_timezone text;
  v_dow_idx int;
  v_dow_key_pt text;
  v_dow_key_en text;
  v_dow_yest_idx int;
  v_dow_yest_pt text;
  v_dow_yest_en text;
  v_dow_keys_pt text[] := ARRAY['dom','seg','ter','qua','qui','sex','sab'];
  v_dow_keys_en text[] := ARRAY['sun','mon','tue','wed','thu','fri','sat'];
  v_holiday_mmdd text;
  v_hhmm text;
  v_currently_running boolean;
  v_holiday_cfg RECORD;
  v_effective_on text;
  v_effective_off text;
  v_skip_day_check boolean;
  v_tsnn text;
  v_plc_total int;
  v_frame text;
  v_lora text;
  v_payload text;
  v_radio text;
  v_via_rep boolean;
  v_new_cmd_id uuid;
  v_in_on_window boolean;
  v_in_off_window boolean;
  v_cross_day boolean;
  v_today_in_days boolean;
  v_yest_in_days boolean;
  v_holidays text[] := ARRAY[
    '01-01','04-21','05-01','09-07','10-12','11-02','11-15','12-25'
  ];
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
    v_dow_idx := EXTRACT(DOW FROM v_local_now)::int;
    v_dow_key_pt := v_dow_keys_pt[v_dow_idx + 1];
    v_dow_key_en := v_dow_keys_en[v_dow_idx + 1];
    v_dow_yest_idx := (v_dow_idx + 6) % 7;
    v_dow_yest_pt := v_dow_keys_pt[v_dow_yest_idx + 1];
    v_dow_yest_en := v_dow_keys_en[v_dow_yest_idx + 1];
    v_holiday_mmdd := to_char(v_local_now, 'MM-DD');
    v_hhmm := to_char(v_local_now, 'HH24:MI');

    v_effective_on := v_sched.time_on;
    v_effective_off := v_sched.time_off;
    v_skip_day_check := false;

    IF v_holiday_mmdd = ANY(v_holidays) THEN
      SELECT * INTO v_holiday_cfg FROM public.automation_holiday_configs
      WHERE farm_id = v_sched.farm_id AND equipment_id = v_sched.equipment_id LIMIT 1;
      IF FOUND AND v_holiday_cfg.enabled THEN
        IF v_holiday_cfg.mode = 'free-demand' THEN CONTINUE;
        ELSIF v_holiday_cfg.mode = 'special-schedule' THEN
          v_effective_on := v_holiday_cfg.special_time_on;
          v_effective_off := v_holiday_cfg.special_time_off;
          v_skip_day_check := true;
        END IF;
      END IF;
    END IF;

    -- Day matching (today / yesterday for cross-day windows)
    v_today_in_days := v_skip_day_check
      OR v_dow_key_pt = ANY(v_sched.days)
      OR v_dow_key_en = ANY(v_sched.days);
    v_yest_in_days := v_skip_day_check
      OR v_dow_yest_pt = ANY(v_sched.days)
      OR v_dow_yest_en = ANY(v_sched.days);

    -- Window evaluation (string compare HH:MM works lexicographically)
    v_cross_day := v_effective_on > v_effective_off;

    IF v_effective_on = v_effective_off THEN
      v_in_on_window := false;
      v_in_off_window := false;
    ELSIF v_cross_day THEN
      -- ON window: [time_on .. 24:00) on day-of-time_on, then [00:00 .. time_off) next day
      v_in_on_window := (v_hhmm >= v_effective_on AND v_today_in_days)
                     OR (v_hhmm < v_effective_off AND v_yest_in_days);
      -- OFF window: [time_off .. time_on) same calendar day
      v_in_off_window := (v_hhmm >= v_effective_off AND v_hhmm < v_effective_on);
    ELSE
      v_in_on_window := (v_hhmm >= v_effective_on AND v_hhmm < v_effective_off AND v_today_in_days);
      v_in_off_window := (v_hhmm < v_effective_on OR v_hhmm >= v_effective_off);
    END IF;

    -- Current pump state from last_outputs_state
    IF v_sched.last_outputs_state ~ '^[01]{6}$' AND COALESCE(v_sched.saida,1) BETWEEN 1 AND 6 THEN
      v_currently_running := substring(v_sched.last_outputs_state from COALESCE(v_sched.saida,1)::int for 1) = '1';
    ELSIF v_sched.last_outputs_state ~ '^[01]$' THEN
      v_currently_running := v_sched.last_outputs_state = '1';
    ELSE
      v_currently_running := false;
    END IF;

    v_tsnn := COALESCE(v_sched.plc_tsnn, substring(v_sched.hw_id from 1 for 4));
    v_plc_total := COALESCE(v_sched.plc_total, 1);

    -- Resolve RF routing once per schedule
    SELECT COALESCE(radio, 'R1'), COALESCE(via_repetidor, false)
      INTO v_radio, v_via_rep
    FROM public.rf_routing WHERE farm_id = v_sched.farm_id;
    IF v_radio IS NULL THEN v_radio := 'R1'; END IF;
    IF v_via_rep IS NULL THEN v_via_rep := false; END IF;

    -- ── ON action: inside ON window, pump off, no pending command, not blocked
    IF v_sched.mode <> 'off-only'
       AND v_in_on_window
       AND v_currently_running = false
       AND v_sched.pending_command_id IS NULL
       AND (v_sched.command_blocked_until IS NULL OR v_sched.command_blocked_until <= v_now)
    THEN
      v_payload := public.renov_combined_payload(
        v_sched.last_outputs_state, COALESCE(v_sched.saida, 1), true, v_plc_total
      );
      v_lora := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';
      v_frame := CASE WHEN v_via_rep THEN 'REP:R3:TX:' || v_radio || ':' || v_lora ELSE v_lora END;

      INSERT INTO public.commands (
        farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device
      ) VALUES (
        v_sched.farm_id, v_sched.equipment_id, v_tsnn, 'manual', 1, v_frame, 120000, 'cloud-automation'
      ) RETURNING id INTO v_new_cmd_id;

      UPDATE public.equipments
      SET pending_command_id = v_new_cmd_id,
          command_blocked_until = v_now + interval '120 seconds',
          desired_running = true,
          updated_at = v_now
      WHERE id = v_sched.equipment_id
        AND pending_command_id IS NULL;

      v_enqueued := v_enqueued + 1;

    -- ── OFF action: inside OFF window, pump on, no pending command
    ELSIF v_sched.mode <> 'on-only'
       AND v_in_off_window
       AND v_currently_running = true
       AND v_sched.pending_command_id IS NULL
       AND (v_sched.command_blocked_until IS NULL OR v_sched.command_blocked_until <= v_now)
    THEN
      v_payload := public.renov_combined_payload(
        v_sched.last_outputs_state, COALESCE(v_sched.saida, 1), false, v_plc_total
      );
      v_lora := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';
      v_frame := CASE WHEN v_via_rep THEN 'REP:R3:TX:' || v_radio || ':' || v_lora ELSE v_lora END;

      INSERT INTO public.commands (
        farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device
      ) VALUES (
        v_sched.farm_id, v_sched.equipment_id, v_tsnn, 'manual', 1, v_frame, 120000, 'cloud-automation'
      ) RETURNING id INTO v_new_cmd_id;

      UPDATE public.equipments
      SET pending_command_id = v_new_cmd_id,
          command_blocked_until = v_now + interval '120 seconds',
          desired_running = false,
          updated_at = v_now
      WHERE id = v_sched.equipment_id
        AND pending_command_id IS NULL;

      v_enqueued := v_enqueued + 1;
    END IF;
  END LOOP;

  INSERT INTO public.automation_tick_logs (schedules_found, commands_inserted, details)
  VALUES (v_evaluated, v_enqueued, jsonb_build_object('mode', 'window-based', 'version', 2));

  enqueued_count := v_enqueued;
  schedules_evaluated := v_evaluated;
  RETURN NEXT;
END;
$function$;
