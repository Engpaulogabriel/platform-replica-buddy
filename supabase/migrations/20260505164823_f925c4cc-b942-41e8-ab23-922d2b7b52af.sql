
ALTER TABLE public.plc_groups
  ADD COLUMN IF NOT EXISTS output_count smallint NOT NULL DEFAULT 6;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'plc_groups_output_count_range'
  ) THEN
    ALTER TABLE public.plc_groups
      ADD CONSTRAINT plc_groups_output_count_range
      CHECK (output_count BETWEEN 1 AND 6);
  END IF;
END $$;

-- Helper: monta payload combinado preservando estado atual.
-- Se total=1 retorna payload de 1 dígito (posicional puro).
CREATE OR REPLACE FUNCTION public.renov_combined_payload(
  _current_state text,
  _saida int,
  _turn_on boolean,
  _total int
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_n int;
  v_pos int;
  v_state text;
BEGIN
  v_n := GREATEST(1, LEAST(6, COALESCE(_total, 1)));
  v_pos := GREATEST(1, LEAST(v_n, COALESCE(_saida, 1)));

  IF _current_state ~ ('^[01]{' || v_n || '}$') THEN
    v_state := _current_state;
  ELSIF _current_state ~ '^[01]{6}$' THEN
    v_state := substring(_current_state from 1 for v_n);
  ELSE
    v_state := repeat('0', v_n);
  END IF;

  RETURN overlay(v_state placing CASE WHEN _turn_on THEN '1' ELSE '0' END from v_pos for 1);
END;
$$;

-- ───────────────────────────────────────────────────────────────────
-- enqueue_reset_pump_command: usa payload combinado da PLC
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enqueue_reset_pump_command(
  _farm_id uuid, _equipment_id uuid, _reason text DEFAULT 'manual_reset'::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_eq RECORD;
  v_tsnn text;
  v_total int := 1;
  v_payload text;
  v_frame text;
  v_command_id uuid;
  v_source_device text;
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissão para fazenda %', _farm_id;
  END IF;

  SELECT e.*,
         COALESCE(pg.hw_id, substring(e.hw_id from 1 for 4)) AS plc_tsnn,
         COALESCE(pg.output_count, 1) AS plc_total
  INTO v_eq
  FROM public.equipments e
  LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
  WHERE e.id = _equipment_id
    AND e.farm_id = _farm_id
    AND e.type IN ('poco', 'bombeamento')
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Equipamento % não encontrado', _equipment_id;
  END IF;

  v_tsnn := v_eq.plc_tsnn;
  IF v_tsnn IS NULL OR v_tsnn !~ '^\d{4}$' THEN
    RAISE EXCEPTION 'PLC inválido para equipamento %', _equipment_id;
  END IF;

  v_total := GREATEST(v_eq.plc_total, COALESCE(v_eq.saida, 1));
  v_payload := public.renov_combined_payload(
    v_eq.last_outputs_state, COALESCE(v_eq.saida, 1), false, v_total
  );
  v_frame := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';
  v_source_device := left('backend-reset:' || COALESCE(_reason, 'manual_reset'), 80);

  UPDATE public.commands
  SET status = 'cancelled',
      responded_at = now(),
      error_message = 'Cancelado por reset de segurança'
  WHERE farm_id = _farm_id
    AND status IN ('pending', 'sent')
    AND (
      equipment_id = _equipment_id
      OR (plc_hw_id = v_tsnn AND type = 'polling')
    );

  INSERT INTO public.commands (
    farm_id, equipment_id, plc_hw_id, type, status, priority, frame,
    timeout_ms, source_device
  ) VALUES (
    _farm_id, _equipment_id, v_tsnn, 'manual', 'pending', 0, v_frame,
    10000, v_source_device
  )
  RETURNING id INTO v_command_id;

  UPDATE public.equipments
  SET pending_command_id = v_command_id,
      command_blocked_until = NULL,
      desired_running = false,
      safety_expired_at = now(),
      updated_at = now()
  WHERE id = _equipment_id
    AND farm_id = _farm_id;

  RETURN v_command_id;
END;
$function$;

-- ───────────────────────────────────────────────────────────────────
-- enqueue_protective_off_for_offline_pumps: usa payload combinado
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enqueue_protective_off_for_offline_pumps()
RETURNS TABLE(farm_id uuid, equipment_id uuid, equipment_name text, command_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_eq RECORD;
  v_offline_threshold interval := interval '15 minutes';
  v_tsnn text;
  v_frame text;
  v_payload text;
  v_total int;
  v_cmd_id uuid;
  v_state text;
  v_idx int;
  v_was_on boolean;
  v_existing uuid;
BEGIN
  FOR v_eq IN
    SELECT
      e.id, e.farm_id, e.name, e.hw_id, e.saida, e.last_outputs_state,
      e.last_communication, e.desired_running,
      p.hw_id AS plc_hw_id,
      COALESCE(p.output_count, 1) AS plc_total
    FROM public.equipments e
    LEFT JOIN public.plc_groups p ON p.id = e.plc_group_id
    WHERE e.active = true
      AND e.type IN ('poco', 'bombeamento')
      AND (e.last_communication IS NULL OR e.last_communication < now() - v_offline_threshold)
  LOOP
    v_state := COALESCE(v_eq.last_outputs_state, '');
    v_idx := COALESCE(v_eq.saida, 1) - 1;
    v_was_on := false;

    IF v_state ~ '^[01]{6}$' AND v_idx >= 0 AND v_idx < 6 THEN
      v_was_on := substring(v_state from v_idx + 1 for 1) = '1';
    ELSIF v_state ~ '^[01]$' THEN
      v_was_on := v_state = '1';
    END IF;

    IF NOT v_was_on AND NOT COALESCE(v_eq.desired_running, false) THEN
      CONTINUE;
    END IF;

    v_tsnn := COALESCE(v_eq.plc_hw_id, substring(v_eq.hw_id from 1 for 4));
    IF v_tsnn IS NULL OR length(v_tsnn) = 0 THEN CONTINUE; END IF;

    SELECT c.id INTO v_existing
    FROM public.commands c
    WHERE c.farm_id = v_eq.farm_id
      AND c.equipment_id = v_eq.id
      AND c.status IN ('pending', 'sent')
      AND c.frame ~ '\{0+\}'
      AND c.frame !~ '\{[01]*1[01]*\}'
    LIMIT 1;
    IF v_existing IS NOT NULL THEN CONTINUE; END IF;

    UPDATE public.commands c
    SET status = 'cancelled', responded_at = now(),
        error_message = 'Cancelado por proteção offline — substituido por OFF de segurança'
    WHERE c.farm_id = v_eq.farm_id
      AND c.equipment_id = v_eq.id
      AND c.status IN ('pending', 'sent')
      AND c.type = 'manual'
      AND c.frame ~ '\{[01]*1[01]*\}';

    v_total := GREATEST(v_eq.plc_total, COALESCE(v_eq.saida, 1));
    v_payload := public.renov_combined_payload(
      v_eq.last_outputs_state, COALESCE(v_eq.saida, 1), false, v_total
    );
    v_frame := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';

    INSERT INTO public.commands (
      farm_id, equipment_id, plc_hw_id, type, priority, frame,
      timeout_ms, source_device, status
    ) VALUES (
      v_eq.farm_id, v_eq.id, v_tsnn, 'manual', 0, v_frame,
      7200000, 'cloud-protective-off', 'pending'
    )
    RETURNING id INTO v_cmd_id;

    UPDATE public.equipments
    SET desired_running = false, pending_command_id = v_cmd_id, updated_at = now()
    WHERE id = v_eq.id AND farm_id = v_eq.farm_id;

    INSERT INTO public.agent_logs (farm_id, level, category, message)
    VALUES (
      v_eq.farm_id, 'warn', 'safety',
      format('Bomba %s offline > 15 min com último estado=LIGADA — enfileirado TX OFF combinado de segurança (cmd %s).',
             v_eq.name, v_cmd_id)
    );

    farm_id := v_eq.farm_id; equipment_id := v_eq.id;
    equipment_name := v_eq.name; command_id := v_cmd_id;
    RETURN NEXT;
  END LOOP;
  RETURN;
END;
$function$;

-- ───────────────────────────────────────────────────────────────────
-- run_automation_tick: usa renov_combined_payload com output_count
-- ───────────────────────────────────────────────────────────────────
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
  v_plc_total int;
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
           e.plc_group_id, e.type AS eq_type, f.timezone,
           COALESCE(pg.output_count, 1) AS plc_total,
           pg.hw_id AS plc_tsnn
    FROM public.automation_schedules s
    JOIN public.equipments e ON e.id = s.equipment_id
    JOIN public.farms f ON f.id = s.farm_id
    LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
    WHERE s.active = true AND e.active = true AND e.type IN ('poco','bombeamento')
  LOOP
    v_evaluated := v_evaluated + 1;

    SELECT COALESCE((SELECT enabled FROM public.automation_engine WHERE farm_id = v_sched.farm_id), true)
      INTO v_engine_on;
    IF NOT v_engine_on THEN CONTINUE; END IF;

    SELECT COALESCE(radio, 'R1'), COALESCE(via_repetidor, false)
      INTO v_radio, v_via_rep
    FROM public.rf_routing WHERE farm_id = v_sched.farm_id;
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

    IF NOT v_skip_day_check AND NOT (v_dow_key = ANY(v_sched.days)) THEN CONTINUE; END IF;

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

    v_tsnn := COALESCE(v_sched.plc_tsnn, substring(v_sched.hw_id from 1 for 4));
    v_plc_total := GREATEST(v_sched.plc_total, COALESCE(v_sched.saida, 1));

    IF v_sched.mode <> 'off-only' AND v_inside_window
       AND v_sched.pending_command_id IS NULL
       AND v_currently_running = false
       AND (v_sched.command_blocked_until IS NULL OR v_sched.command_blocked_until <= v_now)
    THEN
      v_minute_key := v_today_key || '|on@' || v_hhmm;
      INSERT INTO public.automation_fired(schedule_id, fired_key)
      VALUES (v_sched.id, v_minute_key) ON CONFLICT DO NOTHING;
      IF FOUND THEN
        v_payload := public.renov_combined_payload(
          v_sched.last_outputs_state, COALESCE(v_sched.saida, 1), true, v_plc_total
        );
        v_lora := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';
        v_frame := CASE WHEN v_via_rep THEN 'REP:R3:TX:' || v_radio || ':' || v_lora ELSE v_lora END;
        INSERT INTO public.commands (
          farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device
        ) VALUES (
          v_sched.farm_id, v_sched.equipment_id, v_tsnn, 'manual', 1, v_frame, 120000, 'cloud-automation'
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
      VALUES (v_sched.id, v_minute_key) ON CONFLICT DO NOTHING;
      IF FOUND THEN
        v_payload := public.renov_combined_payload(
          v_sched.last_outputs_state, COALESCE(v_sched.saida, 1), false, v_plc_total
        );
        v_lora := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';
        v_frame := CASE WHEN v_via_rep THEN 'REP:R3:TX:' || v_radio || ':' || v_lora ELSE v_lora END;
        INSERT INTO public.commands (
          farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device
        ) VALUES (
          v_sched.farm_id, v_sched.equipment_id, v_tsnn, 'manual', 1, v_frame, 120000, 'cloud-automation'
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

-- ───────────────────────────────────────────────────────────────────
-- enqueue_polling_for_due_equipments_internal: usa output_count
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.enqueue_polling_for_due_equipments_internal(_farm_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_plc RECORD;
  v_eq RECORD;
  v_payload text;
  v_pos int;
  v_max_saida int;
  v_plc_total int;
  v_desired_on boolean;
  v_frame text;
  v_first_eq_id uuid;
BEGIN
  DELETE FROM public.commands
  WHERE farm_id = _farm_id AND status = 'pending' AND type = 'polling'
    AND created_at < now() - interval '30 seconds';

  UPDATE public.commands
  SET status = 'timeout', responded_at = now(),
      error_message = 'Sem resposta dentro do timeout'
  WHERE farm_id = _farm_id AND status = 'sent' AND type = 'polling'
    AND sent_at < now() - (GREATEST(timeout_ms, 13000) || ' milliseconds')::interval;

  IF EXISTS (
    SELECT 1 FROM public.commands c
    WHERE c.farm_id = _farm_id AND c.type = 'polling'
      AND c.source_device = 'platform-scheduler'
      AND c.created_at > now() - interval '12.5 seconds'
  ) THEN RETURN 0; END IF;

  IF EXISTS (
    SELECT 1 FROM public.commands c
    WHERE c.farm_id = _farm_id AND c.status IN ('pending', 'sent') AND c.type = 'polling'
  ) THEN RETURN 0; END IF;

  SELECT
    COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) AS tsnn,
    MIN(e.last_polling_at) AS oldest_polling_at,
    MAX(COALESCE(pg.output_count, 1)) AS plc_total
  INTO v_plc
  FROM public.equipments e
  LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
  WHERE e.farm_id = _farm_id AND e.active = true
    AND e.type IN ('poco', 'bombeamento', 'nivel')
    AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) IS NOT NULL
    AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) ~ '^\d{4}$'
    AND NOT EXISTS (
      SELECT 1 FROM public.service_mode_locks sml
      WHERE sml.farm_id = _farm_id
        AND sml.tsnn = COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4))
        AND sml.expires_at > now()
    )
  GROUP BY 1
  ORDER BY oldest_polling_at ASC NULLS FIRST, tsnn ASC
  LIMIT 1;

  IF v_plc.tsnn IS NULL THEN RETURN 0; END IF;

  SELECT COALESCE(MAX(COALESCE(e.saida, 1)), 0)
  INTO v_max_saida
  FROM public.equipments e
  LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
  WHERE e.farm_id = _farm_id AND e.active = true
    AND e.type IN ('poco', 'bombeamento', 'nivel')
    AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) = v_plc.tsnn;

  v_plc_total := GREATEST(v_max_saida, COALESCE(v_plc.plc_total, 1));
  IF v_plc_total < 1 THEN RETURN 0; END IF;
  IF v_plc_total > 6 THEN v_plc_total := 6; END IF;

  v_payload := '';
  v_first_eq_id := NULL;

  FOR v_pos IN 1..v_plc_total LOOP
    v_desired_on := false;
    SELECT e.id, COALESCE(e.desired_running, false) AS desired_running
    INTO v_eq
    FROM public.equipments e
    LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
    WHERE e.farm_id = _farm_id AND e.active = true
      AND e.type IN ('poco', 'bombeamento')
      AND COALESCE(e.saida, 1) = v_pos
      AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) = v_plc.tsnn
    LIMIT 1;

    IF FOUND THEN
      v_desired_on := v_eq.desired_running;
      v_payload := v_payload || (CASE WHEN v_desired_on THEN '1' ELSE '0' END);
      IF v_first_eq_id IS NULL THEN v_first_eq_id := v_eq.id; END IF;
    ELSE
      v_payload := v_payload || '0';
    END IF;
  END LOOP;

  IF v_first_eq_id IS NULL THEN
    SELECT e.id INTO v_first_eq_id
    FROM public.equipments e
    LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
    WHERE e.farm_id = _farm_id AND e.active = true AND e.type = 'nivel'
      AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) = v_plc.tsnn
    ORDER BY COALESCE(e.saida, 1) ASC LIMIT 1;
  END IF;

  v_frame := '[' || v_plc.tsnn || '_1_]{' || v_payload || '}[' || v_plc.tsnn || '_ETX_]' || E'\r';

  INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device)
  VALUES (_farm_id, v_first_eq_id, v_plc.tsnn, 'polling', 5, v_frame, 13000, 'platform-scheduler');

  UPDATE public.equipments e
  SET last_polling_at = now()
  WHERE e.farm_id = _farm_id AND e.active = true
    AND e.type IN ('poco', 'bombeamento', 'nivel')
    AND COALESCE(
          (SELECT pg.hw_id FROM public.plc_groups pg WHERE pg.id = e.plc_group_id),
          substring(e.hw_id from 1 for 4)
        ) = v_plc.tsnn;

  RETURN 1;
END;
$function$;
