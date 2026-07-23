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
  v_dow_idx int;
  v_dow_key text;
  v_dow_keys text[] := ARRAY['dom','seg','ter','qua','qui','sex','sab'];
  v_holiday_mmdd text;
  v_today_key text;
  v_hhmm text;
  v_minute_key text;
  v_now_min int;
  v_on_min int;
  v_off_min int;
  v_inside_window boolean;
  v_currently_running boolean;
  v_holiday_cfg RECORD;
  v_effective_on text;
  v_effective_off text;
  v_skip_day_check boolean;
  v_engine_on boolean;
  v_tsnn text;
  v_frame text;
  v_payload text;
  v_holidays text[] := ARRAY[
    '01-01','04-21','05-01','09-07','10-12','11-02','11-15','12-25'
  ];
BEGIN
  DELETE FROM public.automation_fired WHERE fired_at < now() - interval '2 days';

  v_dow_idx := EXTRACT(DOW FROM v_now)::int;
  v_dow_key := v_dow_keys[v_dow_idx + 1];
  v_holiday_mmdd := to_char(v_now, 'MM-DD');
  v_today_key := to_char(v_now, 'YYYY-MM-DD');
  v_hhmm := to_char(v_now, 'HH24:MI');
  v_now_min := EXTRACT(HOUR FROM v_now)::int * 60 + EXTRACT(MINUTE FROM v_now)::int;

  FOR v_sched IN
    SELECT s.*, e.farm_id AS eq_farm, e.hw_id, e.saida, e.last_outputs_state,
           e.pending_command_id, e.last_actuation_origin, e.command_blocked_until,
           e.plc_group_id, e.type AS eq_type
    FROM public.automation_schedules s
    JOIN public.equipments e ON e.id = s.equipment_id
    WHERE s.active = true
      AND e.active = true
      AND e.type IN ('poco','bombeamento')
  LOOP
    v_evaluated := v_evaluated + 1;

    SELECT COALESCE((SELECT enabled FROM public.automation_engine WHERE farm_id = v_sched.farm_id), true)
      INTO v_engine_on;
    IF NOT v_engine_on THEN CONTINUE; END IF;

    v_effective_on := v_sched.time_on;
    v_effective_off := v_sched.time_off;
    v_skip_day_check := false;

    IF v_holiday_mmdd = ANY(v_holidays) THEN
      SELECT * INTO v_holiday_cfg
      FROM public.automation_holiday_configs
      WHERE farm_id = v_sched.farm_id AND equipment_id = v_sched.equipment_id
      LIMIT 1;

      IF FOUND AND v_holiday_cfg.enabled THEN
        IF v_holiday_cfg.mode = 'free-demand' THEN
          CONTINUE;
        ELSIF v_holiday_cfg.mode = 'special-schedule' THEN
          v_effective_on := v_holiday_cfg.special_time_on;
          v_effective_off := v_holiday_cfg.special_time_off;
          v_skip_day_check := true;
        END IF;
      END IF;
    END IF;

    IF NOT v_skip_day_check AND NOT (v_dow_key = ANY(v_sched.days)) THEN
      CONTINUE;
    END IF;

    v_on_min := (split_part(v_effective_on, ':', 1))::int * 60 + (split_part(v_effective_on, ':', 2))::int;
    v_off_min := (split_part(v_effective_off, ':', 1))::int * 60 + (split_part(v_effective_off, ':', 2))::int;

    IF v_on_min <= v_off_min THEN
      v_inside_window := v_now_min >= v_on_min AND v_now_min < v_off_min;
    ELSE
      v_inside_window := v_now_min >= v_on_min OR v_now_min < v_off_min;
    END IF;

    IF v_sched.last_outputs_state ~ '^[01]{6}$' AND COALESCE(v_sched.saida,1) BETWEEN 1 AND 6 THEN
      v_currently_running := substring(v_sched.last_outputs_state from COALESCE(v_sched.saida,1)::int for 1) = '1';
    ELSIF v_sched.last_outputs_state ~ '^[01]$' THEN
      v_currently_running := v_sched.last_outputs_state = '1';
    ELSE
      v_currently_running := false;
    END IF;

    -- ── ON: dentro da janela, sem comando pendente, bomba desligada ──
    -- Liga a qualquer minuto da janela (não só no início). Ignora "last_actuation_origin=local"
    -- antigo: o bloqueio de 30s (command_blocked_until) ja protege contra TX duplicado.
    IF v_sched.mode <> 'off-only' AND v_inside_window
       AND v_sched.pending_command_id IS NULL
       AND v_currently_running = false
       AND (v_sched.command_blocked_until IS NULL OR v_sched.command_blocked_until <= v_now)
    THEN
      v_minute_key := v_today_key || '|on@' || v_hhmm;
      INSERT INTO public.automation_fired(schedule_id, fired_key)
      VALUES (v_sched.id, v_minute_key)
      ON CONFLICT DO NOTHING;

      IF FOUND THEN
        IF v_sched.plc_group_id IS NOT NULL THEN
          SELECT hw_id INTO v_tsnn FROM public.plc_groups WHERE id = v_sched.plc_group_id;
          v_tsnn := COALESCE(v_tsnn, substring(v_sched.hw_id from 1 for 4));
        ELSE
          v_tsnn := substring(v_sched.hw_id from 1 for 4);
        END IF;

        v_payload := '1';
        v_frame := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';

        INSERT INTO public.commands (
          farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device
        ) VALUES (
          v_sched.farm_id, v_sched.equipment_id, v_tsnn,
          'manual', 1, v_frame, 600000, 'cloud-automation'
        );
        v_enqueued := v_enqueued + 1;
      END IF;
    END IF;

    -- ── OFF: exatamente no horário programado de desligar ──
    IF v_sched.mode <> 'on-only' AND v_hhmm = v_effective_off
       AND v_sched.pending_command_id IS NULL
       AND v_currently_running = true
    THEN
      v_minute_key := v_today_key || '|off@' || v_hhmm;
      INSERT INTO public.automation_fired(schedule_id, fired_key)
      VALUES (v_sched.id, v_minute_key)
      ON CONFLICT DO NOTHING;

      IF FOUND THEN
        IF v_sched.plc_group_id IS NOT NULL THEN
          SELECT hw_id INTO v_tsnn FROM public.plc_groups WHERE id = v_sched.plc_group_id;
          v_tsnn := COALESCE(v_tsnn, substring(v_sched.hw_id from 1 for 4));
        ELSE
          v_tsnn := substring(v_sched.hw_id from 1 for 4);
        END IF;

        v_payload := '0';
        v_frame := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';

        INSERT INTO public.commands (
          farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device
        ) VALUES (
          v_sched.farm_id, v_sched.equipment_id, v_tsnn,
          'manual', 1, v_frame, 600000, 'cloud-automation'
        );
        v_enqueued := v_enqueued + 1;
      END IF;
    END IF;
  END LOOP;

  enqueued_count := v_enqueued;
  schedules_evaluated := v_evaluated;
  RETURN NEXT;
END;
$function$;