CREATE OR REPLACE FUNCTION public.enqueue_reset_pump_command(
  _farm_id uuid,
  _equipment_id uuid,
  _reason text DEFAULT 'manual_reset'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_eq RECORD;
  v_tsnn text;
  v_radio text := 'R1';
  v_via_rep boolean := false;
  v_lora text;
  v_frame text;
  v_command_id uuid;
  v_timeout_ms integer := 120000;
  v_reason text := COALESCE(NULLIF(_reason, ''), 'manual_reset');
BEGIN
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  SELECT e.id, e.farm_id, e.hw_id, e.plc_group_id, e.type
    INTO v_eq
  FROM public.equipments e
  WHERE e.id = _equipment_id
    AND e.farm_id = _farm_id
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Equipamento nao encontrado';
  END IF;

  IF v_eq.type NOT IN ('poco', 'bombeamento') THEN
    RAISE EXCEPTION 'Equipamento % nao aceita reset', v_eq.type;
  END IF;

  IF v_eq.plc_group_id IS NOT NULL THEN
    SELECT pg.hw_id
      INTO v_tsnn
    FROM public.plc_groups pg
    WHERE pg.id = v_eq.plc_group_id
    LIMIT 1;
  END IF;

  v_tsnn := COALESCE(NULLIF(v_tsnn, ''), substring(v_eq.hw_id from 1 for 4));

  SELECT COALESCE(r.radio, 'R1'), COALESCE(r.via_repetidor, false)
    INTO v_radio, v_via_rep
  FROM public.rf_routing r
  WHERE r.farm_id = _farm_id
  LIMIT 1;

  v_lora := '[' || v_tsnn || '_1_]{0}[' || v_tsnn || '_ETX_]' || E'\r';
  v_frame := CASE
    WHEN COALESCE(v_via_rep, false) THEN 'REP:R3:TX:' || COALESCE(v_radio, 'R1') || ':' || v_lora
    ELSE v_lora
  END;

  INSERT INTO public.commands (
    farm_id,
    equipment_id,
    plc_hw_id,
    type,
    priority,
    frame,
    timeout_ms,
    created_by,
    client_event_id,
    source_device
  )
  VALUES (
    _farm_id,
    _equipment_id,
    v_tsnn,
    'manual',
    0,
    v_frame,
    v_timeout_ms,
    auth.uid(),
    gen_random_uuid(),
    left('backend-reset:' || v_reason, 80)
  )
  RETURNING id INTO v_command_id;

  UPDATE public.commands
  SET status = 'cancelled',
      responded_at = now(),
      error_message = CASE
        WHEN v_reason = 'turn_on_timeout'
          THEN 'Cancelado por seguranca: comando 0 enfileirado apos falha ao ligar'
        ELSE 'Cancelado por RESET de emergencia'
      END
  WHERE farm_id = _farm_id
    AND equipment_id = _equipment_id
    AND id <> v_command_id
    AND status IN ('pending', 'sent');

  UPDATE public.equipments
  SET pending_command_id = v_command_id,
      command_blocked_until = NULL,
      desired_running = false,
      updated_at = now()
  WHERE id = _equipment_id
    AND farm_id = _farm_id;

  RETURN v_command_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.enqueue_turn_on_timeout_resets(_farm_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_item RECORD;
  v_count integer := 0;
  v_is_running boolean;
BEGIN
  IF _farm_id IS NULL THEN
    IF COALESCE(auth.role(), '') <> 'service_role' THEN
      RAISE EXCEPTION 'Sem permissao para executar protecao global';
    END IF;
  ELSIF COALESCE(auth.role(), '') <> 'service_role'
        AND NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  FOR v_item IN
    SELECT
      e.farm_id,
      e.id AS equipment_id,
      COALESCE(e.saida, 1) AS saida_idx,
      e.last_outputs_state,
      c.id AS command_id
    FROM public.equipments e
    JOIN public.commands c
      ON c.id = e.pending_command_id
     AND c.farm_id = e.farm_id
    WHERE e.type IN ('poco', 'bombeamento')
      AND c.type = 'manual'
      AND c.status IN ('pending', 'sent')
      AND c.frame ~ '\{1\}'
      AND COALESCE(c.sent_at, c.created_at) <= now() - interval '60 seconds'
      AND (_farm_id IS NULL OR e.farm_id = _farm_id)
  LOOP
    v_is_running := false;

    IF v_item.last_outputs_state ~ '^[01]{6}$' AND v_item.saida_idx BETWEEN 1 AND 6 THEN
      v_is_running := substring(v_item.last_outputs_state from v_item.saida_idx for 1) = '1';
    ELSIF v_item.last_outputs_state ~ '^[01]$' THEN
      v_is_running := v_item.last_outputs_state = '1';
    END IF;

    IF v_is_running THEN
      CONTINUE;
    END IF;

    PERFORM public.enqueue_reset_pump_command(v_item.farm_id, v_item.equipment_id, 'turn_on_timeout');

    UPDATE public.commands
    SET status = 'timeout',
        responded_at = now(),
        error_message = 'Bomba nao ligou em 60s — comando 0 enfileirado por seguranca'
    WHERE id = v_item.command_id
      AND status IN ('pending', 'sent');

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_commands_timeout(_farm_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_count integer;
  v_reset_count integer := 0;
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissão para fazenda %', _farm_id;
  END IF;

  WITH updated AS (
    UPDATE public.commands
    SET status = 'timeout',
        responded_at = now(),
        error_message = 'Sem resposta dentro do timeout'
    WHERE farm_id = _farm_id
      AND status = 'sent'
      AND sent_at < now() - (timeout_ms || ' milliseconds')::interval
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM updated;

  v_reset_count := public.enqueue_turn_on_timeout_resets(_farm_id);

  RETURN COALESCE(v_count, 0) + COALESCE(v_reset_count, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.run_automation_tick()
RETURNS TABLE(enqueued_count integer, schedules_evaluated integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_enqueued int := 0;
  v_evaluated int := 0;
  v_sched RECORD;
  v_now timestamptz := now();
  v_local_now timestamp;
  v_timezone text;
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
  v_lora text;
  v_payload text;
  v_radio text;
  v_via_rep boolean;
  v_holidays text[] := ARRAY[
    '01-01','04-21','05-01','09-07','10-12','11-02','11-15','12-25'
  ];
BEGIN
  PERFORM public.enqueue_turn_on_timeout_resets(NULL);

  DELETE FROM public.automation_fired WHERE fired_at < now() - interval '2 days';

  FOR v_sched IN
    SELECT s.*, e.farm_id AS eq_farm, e.hw_id, e.saida, e.last_outputs_state,
           e.pending_command_id, e.last_actuation_origin, e.command_blocked_until,
           e.plc_group_id, e.type AS eq_type, f.timezone
    FROM public.automation_schedules s
    JOIN public.equipments e ON e.id = s.equipment_id
    JOIN public.farms f ON f.id = s.farm_id
    WHERE s.active = true
      AND e.active = true
      AND e.type IN ('poco','bombeamento')
  LOOP
    v_evaluated := v_evaluated + 1;

    SELECT COALESCE((SELECT enabled FROM public.automation_engine WHERE farm_id = v_sched.farm_id), true)
      INTO v_engine_on;
    IF NOT v_engine_on THEN CONTINUE; END IF;

    SELECT COALESCE(radio, 'R1'), COALESCE(via_repetidor, false)
      INTO v_radio, v_via_rep
    FROM public.rf_routing
    WHERE farm_id = v_sched.farm_id;
    IF v_radio IS NULL THEN v_radio := 'R1'; END IF;
    IF v_via_rep IS NULL THEN v_via_rep := false; END IF;

    v_timezone := COALESCE(NULLIF(v_sched.timezone, ''), 'America/Sao_Paulo');
    v_local_now := v_now AT TIME ZONE v_timezone;
    v_dow_idx := EXTRACT(DOW FROM v_local_now)::int;
    v_dow_key := v_dow_keys[v_dow_idx + 1];
    v_holiday_mmdd := to_char(v_local_now, 'MM-DD');
    v_today_key := to_char(v_local_now, 'YYYY-MM-DD');
    v_hhmm := to_char(v_local_now, 'HH24:MI');
    v_now_min := EXTRACT(HOUR FROM v_local_now)::int * 60 + EXTRACT(MINUTE FROM v_local_now)::int;

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

    IF v_sched.plc_group_id IS NOT NULL THEN
      SELECT hw_id INTO v_tsnn FROM public.plc_groups WHERE id = v_sched.plc_group_id;
      v_tsnn := COALESCE(v_tsnn, substring(v_sched.hw_id from 1 for 4));
    ELSE
      v_tsnn := substring(v_sched.hw_id from 1 for 4);
    END IF;

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
        v_payload := '1';
        v_lora := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';
        IF v_via_rep THEN
          v_frame := 'REP:R3:TX:' || v_radio || ':' || v_lora;
        ELSE
          v_frame := v_lora;
        END IF;

        INSERT INTO public.commands (
          farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device
        ) VALUES (
          v_sched.farm_id, v_sched.equipment_id, v_tsnn,
          'manual', 1, v_frame, 600000, 'cloud-automation'
        );
        v_enqueued := v_enqueued + 1;
      END IF;
    END IF;

    IF v_sched.mode <> 'on-only' AND v_hhmm = v_effective_off
       AND v_sched.pending_command_id IS NULL
       AND v_currently_running = true
    THEN
      v_minute_key := v_today_key || '|off@' || v_hhmm;
      INSERT INTO public.automation_fired(schedule_id, fired_key)
      VALUES (v_sched.id, v_minute_key)
      ON CONFLICT DO NOTHING;

      IF FOUND THEN
        v_payload := '0';
        v_lora := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';
        IF v_via_rep THEN
          v_frame := 'REP:R3:TX:' || v_radio || ':' || v_lora;
        ELSE
          v_frame := v_lora;
        END IF;

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
$$;