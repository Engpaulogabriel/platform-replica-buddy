CREATE OR REPLACE FUNCTION public.run_peak_hour_tick()
RETURNS TABLE(off_enqueued integer, on_enqueued integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_cfg RECORD;
  v_eq RECORD;
  v_now timestamptz := now();
  v_tz text;
  v_local timestamp;
  v_local_date date;
  v_hhmm text;
  v_start text;
  v_end text;
  v_in_window boolean;
  v_should_off boolean;
  v_should_on boolean;
  v_off int := 0;
  v_on int := 0;
  v_currently_running boolean;
  v_tsnn text;
  v_plc_total int;
  v_payload text;
  v_lora text;
  v_frame text;
  v_radio text;
  v_via_rep boolean;
  v_new_cmd_id uuid;
  v_affected uuid[];
BEGIN
  FOR v_cfg IN
    SELECT p.*, f.timezone
      FROM public.peak_hour_config p
      JOIN public.farms f ON f.id = p.farm_id
     WHERE p.enabled = true
  LOOP
    v_tz := COALESCE(NULLIF(v_cfg.timezone,''), 'America/Sao_Paulo');
    v_local := v_now AT TIME ZONE v_tz;
    v_local_date := v_local::date;
    v_hhmm := to_char(v_local, 'HH24:MI');
    v_start := to_char(v_cfg.start_time, 'HH24:MI');
    v_end := to_char(v_cfg.end_time, 'HH24:MI');

    -- Should fire OFF? local time has just crossed start_time, and not yet acted today
    v_should_off := (v_hhmm >= v_start AND v_hhmm < v_end)
                    AND (v_cfg.last_peak_off_at IS NULL
                         OR (v_cfg.last_peak_off_at AT TIME ZONE v_tz)::date < v_local_date);

    -- Should fire ON? local time has crossed end_time, auto_restart, and not yet acted today
    v_should_on := v_cfg.auto_restart
                   AND v_hhmm >= v_end
                   AND (v_cfg.last_peak_on_at IS NULL
                        OR (v_cfg.last_peak_on_at AT TIME ZONE v_tz)::date < v_local_date)
                   AND v_cfg.last_peak_off_at IS NOT NULL
                   AND (v_cfg.last_peak_off_at AT TIME ZONE v_tz)::date = v_local_date;

    IF NOT v_should_off AND NOT v_should_on THEN
      CONTINUE;
    END IF;

    -- Resolve RF routing
    SELECT COALESCE(radio,'R1'), COALESCE(via_repetidor,false)
      INTO v_radio, v_via_rep
      FROM public.rf_routing WHERE farm_id = v_cfg.farm_id;
    IF v_radio IS NULL THEN v_radio := 'R1'; END IF;
    IF v_via_rep IS NULL THEN v_via_rep := false; END IF;

    IF v_should_off THEN
      v_affected := ARRAY[]::uuid[];
      FOR v_eq IN
        SELECT e.*, COALESCE(pg.output_count,1) AS plc_total, pg.hw_id AS plc_tsnn
          FROM public.equipments e
          LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
         WHERE e.farm_id = v_cfg.farm_id
           AND e.active = true
           AND e.type IN ('poco','bombeamento')
           AND NOT (e.id = ANY(COALESCE(v_cfg.excluded_equipment_ids, ARRAY[]::uuid[])))
      LOOP
        IF v_eq.last_outputs_state ~ '^[01]{6}$' AND COALESCE(v_eq.saida,1) BETWEEN 1 AND 6 THEN
          v_currently_running := substring(v_eq.last_outputs_state from COALESCE(v_eq.saida,1)::int for 1) = '1';
        ELSIF v_eq.last_outputs_state ~ '^[01]$' THEN
          v_currently_running := v_eq.last_outputs_state = '1';
        ELSE
          v_currently_running := false;
        END IF;

        IF NOT v_currently_running THEN CONTINUE; END IF;
        IF v_eq.pending_command_id IS NOT NULL THEN CONTINUE; END IF;
        IF v_eq.command_blocked_until IS NOT NULL AND v_eq.command_blocked_until > v_now THEN CONTINUE; END IF;

        v_tsnn := COALESCE(v_eq.plc_tsnn, substring(v_eq.hw_id from 1 for 4));
        v_plc_total := COALESCE(v_eq.plc_total, 1);
        v_payload := public.renov_combined_payload(v_eq.last_outputs_state, COALESCE(v_eq.saida,1), false, v_plc_total);
        v_lora := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';
        v_frame := CASE WHEN v_via_rep THEN 'REP:R3:TX:' || v_radio || ':' || v_lora ELSE v_lora END;

        INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device)
        VALUES (v_cfg.farm_id, v_eq.id, v_tsnn, 'manual', 1, v_frame, 120000, 'peak-hour')
        RETURNING id INTO v_new_cmd_id;

        UPDATE public.equipments
           SET pending_command_id = v_new_cmd_id,
               command_blocked_until = v_now + interval '120 seconds',
               desired_running = false,
               updated_at = v_now
         WHERE id = v_eq.id AND pending_command_id IS NULL;

        v_affected := array_append(v_affected, v_eq.id);
        v_off := v_off + 1;
      END LOOP;

      UPDATE public.peak_hour_config
         SET last_peak_off_at = v_now,
             affected_equipment_ids = v_affected
       WHERE id = v_cfg.id;
    END IF;

    IF v_should_on THEN
      FOR v_eq IN
        SELECT e.*, COALESCE(pg.output_count,1) AS plc_total, pg.hw_id AS plc_tsnn
          FROM public.equipments e
          LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
         WHERE e.id = ANY(COALESCE(v_cfg.affected_equipment_ids, ARRAY[]::uuid[]))
           AND e.active = true
      LOOP
        IF v_eq.last_outputs_state ~ '^[01]{6}$' AND COALESCE(v_eq.saida,1) BETWEEN 1 AND 6 THEN
          v_currently_running := substring(v_eq.last_outputs_state from COALESCE(v_eq.saida,1)::int for 1) = '1';
        ELSIF v_eq.last_outputs_state ~ '^[01]$' THEN
          v_currently_running := v_eq.last_outputs_state = '1';
        ELSE
          v_currently_running := false;
        END IF;

        IF v_currently_running THEN CONTINUE; END IF;
        IF v_eq.pending_command_id IS NOT NULL THEN CONTINUE; END IF;
        IF v_eq.command_blocked_until IS NOT NULL AND v_eq.command_blocked_until > v_now THEN CONTINUE; END IF;

        v_tsnn := COALESCE(v_eq.plc_tsnn, substring(v_eq.hw_id from 1 for 4));
        v_plc_total := COALESCE(v_eq.plc_total, 1);
        v_payload := public.renov_combined_payload(v_eq.last_outputs_state, COALESCE(v_eq.saida,1), true, v_plc_total);
        v_lora := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';
        v_frame := CASE WHEN v_via_rep THEN 'REP:R3:TX:' || v_radio || ':' || v_lora ELSE v_lora END;

        INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device)
        VALUES (v_cfg.farm_id, v_eq.id, v_tsnn, 'manual', 1, v_frame, 120000, 'peak-hour')
        RETURNING id INTO v_new_cmd_id;

        UPDATE public.equipments
           SET pending_command_id = v_new_cmd_id,
               command_blocked_until = v_now + interval '120 seconds',
               desired_running = true,
               updated_at = v_now
         WHERE id = v_eq.id AND pending_command_id IS NULL;

        v_on := v_on + 1;
      END LOOP;

      UPDATE public.peak_hour_config
         SET last_peak_on_at = v_now,
             affected_equipment_ids = ARRAY[]::uuid[]
       WHERE id = v_cfg.id;
    END IF;
  END LOOP;

  off_enqueued := v_off;
  on_enqueued := v_on;
  RETURN NEXT;
END;
$function$;