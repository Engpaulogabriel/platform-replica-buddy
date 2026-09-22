CREATE OR REPLACE FUNCTION public.apply_pump_telemetry(_farm_id uuid, _tsnn text, _payload text, _signal_bars smallint, _command_id uuid, _raw_response text, _origin text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_first_eq_id uuid := NULL;
  v_command_is_manual boolean := false;
  v_cmd_equipment_id uuid := NULL;
  v_cmd_frame text := NULL;
  v_cmd_payload text := NULL;
  v_payload_saida int := NULL;
  v_payload_bit text := NULL;
  v_is_full_bitfield boolean := false;
  v_eq RECORD;
  v_base_state text;
  v_payload_to_store text;
  v_origin text;
  v_blocked_until timestamptz;
  v_state_changed boolean;
  v_new_running boolean;
  v_old_running boolean;
  v_pending_frame text;
  v_pending_payload text;
  v_pending_is_manual boolean := false;
  v_pending_source_device text;
  v_pending_is_protective_reset boolean := false;
  v_pending_status public.command_status;
  v_pending_started_at timestamptz;
  v_pending_expected_bit text;
  v_received_bit text;
  v_pending_confirms_expected boolean := false;
  v_pending_within_start_window boolean := false;
  v_pending_reset_still_waiting boolean := false;
  v_pending_command_active boolean := false;
  v_recent_safety_expiry boolean := false;
  v_recent_remote_match boolean := false;
  v_desired_matches_received boolean := false;
  v_clear_pending boolean := false;
  v_enqueue_safety_off boolean := false;
  v_next_desired_running boolean := NULL;
  v_explicit_origin text := NULL;
  v_old_desired boolean;
  v_audit_cmd record;
  v_tsnn_norm text;
  v_plc_output_count int := 6;
  v_recent_manual_cmd boolean := false;
  v_recent_cmd_90s boolean := false;
  v_local_no_recent_cmd boolean := false;
  v_preserve_local boolean := false;
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;
  v_tsnn_norm := upper(coalesce(_tsnn, ''));
  IF _origin IS NOT NULL THEN
    IF lower(_origin) = 'local' THEN
      v_explicit_origin := 'local';
    ELSIF lower(_origin) IN ('remote', 'remote-cmd', 'remote-desired', 'remote_cmd', 'remote_desired') THEN
      v_explicit_origin := 'remote';
    END IF;
  END IF;
  IF _command_id IS NOT NULL THEN
    SELECT type = 'manual', equipment_id, frame
      INTO v_command_is_manual, v_cmd_equipment_id, v_cmd_frame
    FROM public.commands
    WHERE id = _command_id AND farm_id = _farm_id
    LIMIT 1;
    v_command_is_manual := COALESCE(v_command_is_manual, false);
    IF v_cmd_frame IS NOT NULL THEN
      v_cmd_payload := substring(v_cmd_frame from '\{([01]{1,6})\}');
    END IF;
  END IF;
  SELECT COALESCE(output_count, 6) INTO v_plc_output_count
    FROM public.plc_groups
    WHERE farm_id = _farm_id
      AND upper(hw_id) = v_tsnn_norm
    LIMIT 1;
  v_plc_output_count := COALESCE(v_plc_output_count, 6);
  IF _payload IS NULL OR _payload = '' THEN
    v_payload_saida := NULL;
    v_payload_bit := NULL;
  ELSIF _payload ~ '^[01]{6}$' THEN
    v_is_full_bitfield := true;
  ELSIF _payload ~ '^[01]{2,5}$' AND v_plc_output_count > 1 AND length(_payload) = v_plc_output_count THEN
    v_is_full_bitfield := true;
  ELSIF _payload ~ '^[01]{2,5}$' THEN
    v_payload_saida := length(_payload);
    v_payload_bit := substring(_payload from length(_payload) for 1);
  ELSIF _payload ~ '^[01]$' THEN
    v_payload_bit := _payload;
    IF v_cmd_payload IS NOT NULL AND v_cmd_payload ~ '^[01]{1,5}$' THEN
      v_payload_saida := length(v_cmd_payload);
    ELSIF v_cmd_equipment_id IS NOT NULL THEN
      SELECT COALESCE(saida, 1) INTO v_payload_saida
        FROM public.equipments WHERE id = v_cmd_equipment_id LIMIT 1;
    ELSE
      v_payload_saida := 1;
    END IF;
  ELSE
    v_payload_saida := NULL;
    v_payload_bit := NULL;
  END IF;
  FOR v_eq IN
    SELECT id, name, COALESCE(saida, 1) AS saida, pending_command_id, last_outputs_state, desired_running, last_actuation_origin, safety_expired_at, command_blocked_until
    FROM public.equipments
    WHERE farm_id = _farm_id
      AND upper(substring(hw_id from 1 for 4)) = v_tsnn_norm
    ORDER BY COALESCE(saida, 1), id
  LOOP
    IF v_first_eq_id IS NULL THEN
      v_first_eq_id := v_eq.id;
    END IF;
    v_state_changed := false;
    v_origin := NULL;
    v_blocked_until := NULL;
    v_pending_frame := NULL;
    v_pending_payload := NULL;
    v_pending_is_manual := false;
    v_pending_source_device := NULL;
    v_pending_is_protective_reset := false;
    v_pending_status := NULL;
    v_pending_started_at := NULL;
    v_pending_expected_bit := NULL;
    v_received_bit := NULL;
    v_pending_confirms_expected := false;
    v_pending_within_start_window := false;
    v_pending_reset_still_waiting := false;
    v_pending_command_active := false;
    v_recent_safety_expiry := COALESCE(v_eq.safety_expired_at > now() - interval '30 seconds', false);
    v_recent_remote_match := false;
    v_desired_matches_received := false;
    v_clear_pending := false;
    v_enqueue_safety_off := false;
    v_next_desired_running := NULL;
    v_new_running := NULL;
    v_old_running := NULL;
    v_payload_to_store := NULL;
    v_old_desired := COALESCE(v_eq.desired_running, false);
    v_recent_manual_cmd := false;
    v_recent_cmd_90s := false;
    v_local_no_recent_cmd := false;
    v_preserve_local := false;
    IF v_eq.last_outputs_state ~ '^[01]{6}$' THEN
      v_base_state := v_eq.last_outputs_state;
    ELSE
      v_base_state := '000000';
    END IF;
    IF v_is_full_bitfield THEN
      v_payload_to_store := rpad(_payload, 6, '0');
      IF v_eq.saida BETWEEN 1 AND 6 THEN
        v_received_bit := substring(_payload from v_eq.saida::int for 1);
        v_new_running := v_received_bit = '1';
      END IF;
    ELSIF v_payload_saida IS NOT NULL AND v_payload_bit IS NOT NULL THEN
      v_payload_to_store := overlay(v_base_state placing v_payload_bit
                                    from v_payload_saida::int for 1);
      IF v_eq.saida = v_payload_saida THEN
        v_received_bit := v_payload_bit;
        v_new_running := v_received_bit = '1';
      END IF;
    END IF;
    IF v_eq.saida BETWEEN 1 AND 6 THEN
      v_old_running := substring(v_base_state from v_eq.saida::int for 1) = '1';
    END IF;
    IF v_old_running IS NOT NULL AND v_new_running IS NOT NULL THEN
      v_state_changed := v_new_running IS DISTINCT FROM v_old_running;
    END IF;
    IF v_eq.pending_command_id IS NOT NULL THEN
      SELECT frame, type = 'manual', status, COALESCE(sent_at, created_at), source_device
        INTO v_pending_frame, v_pending_is_manual, v_pending_status, v_pending_started_at, v_pending_source_device
      FROM public.commands
      WHERE id = v_eq.pending_command_id AND farm_id = _farm_id
      LIMIT 1;
    END IF;
    IF (NOT v_pending_is_manual OR v_pending_frame IS NULL) AND _command_id IS NOT NULL
       AND v_cmd_equipment_id = v_eq.id THEN
      SELECT frame, type = 'manual', status, COALESCE(sent_at, created_at), source_device
        INTO v_pending_frame, v_pending_is_manual, v_pending_status, v_pending_started_at, v_pending_source_device
      FROM public.commands
      WHERE id = _command_id AND farm_id = _farm_id
      LIMIT 1;
    END IF;
    IF (NOT v_pending_is_manual OR v_pending_frame IS NULL) THEN
      SELECT frame, type = 'manual', status, COALESCE(sent_at, created_at), source_device
        INTO v_pending_frame, v_pending_is_manual, v_pending_status, v_pending_started_at, v_pending_source_device
      FROM public.commands c
      WHERE c.farm_id = _farm_id
        AND c.equipment_id = v_eq.id
        AND c.type = 'manual'
        AND COALESCE(c.source_device, '') NOT LIKE 'backend-reset:%'
        AND COALESCE(c.sent_at, c.created_at) > now() - interval '60 seconds'
      ORDER BY COALESCE(c.sent_at, c.created_at) DESC
      LIMIT 1;
    END IF;
    IF v_received_bit IN ('0','1') THEN
      v_desired_matches_received := COALESCE(v_eq.desired_running, false) = (v_received_bit = '1');
    END IF;
    SELECT EXISTS (
      SELECT 1 FROM public.commands c
      WHERE c.farm_id = _farm_id
        AND c.equipment_id = v_eq.id
        AND c.type = 'manual'
        AND COALESCE(c.source_device, '') NOT LIKE 'backend-reset:%'
        AND COALESCE(c.sent_at, c.created_at) > now() - interval '30 seconds'
    ) INTO v_recent_manual_cmd;
    SELECT EXISTS (
      SELECT 1 FROM public.commands c
      WHERE c.farm_id = _farm_id
        AND c.equipment_id = v_eq.id
        AND c.type IN ('manual', 'automation')
        AND COALESCE(c.source_device, '') NOT LIKE 'backend-reset:%'
        AND COALESCE(c.sent_at, c.created_at) > now() - interval '90 seconds'
    ) INTO v_recent_cmd_90s;
    v_pending_command_active := v_pending_frame IS NOT NULL AND COALESCE(v_pending_status, 'pending'::public.command_status) IN ('pending'::public.command_status, 'sent'::public.command_status, 'delivered'::public.command_status);
    v_pending_is_protective_reset := COALESCE(v_pending_source_device, '') LIKE 'backend-reset:%';
    IF v_pending_is_manual AND v_received_bit IS NOT NULL AND v_pending_frame IS NOT NULL THEN
      v_pending_payload := substring(v_pending_frame from '\{([01]{1,6})\}');
      IF v_pending_payload ~ '^[01]$' THEN
        v_pending_expected_bit := v_pending_payload;
      ELSIF v_pending_payload ~ '^[01]{2,5}$' AND v_plc_output_count > 1 AND length(v_pending_payload) = v_plc_output_count AND v_eq.saida BETWEEN 1 AND v_plc_output_count THEN
        v_pending_expected_bit := substring(v_pending_payload from v_eq.saida::int for 1);
      ELSIF v_pending_payload ~ '^[01]{2,5}$' THEN
        v_pending_expected_bit := substring(v_pending_payload from length(v_pending_payload) for 1);
      ELSIF v_pending_payload ~ '^[01]{6}$' AND v_eq.saida BETWEEN 1 AND 6 THEN
        v_pending_expected_bit := substring(v_pending_payload from v_eq.saida::int for 1);
      END IF;
      v_pending_confirms_expected := v_pending_expected_bit IS NOT NULL
                                     AND v_received_bit = v_pending_expected_bit;
      v_pending_within_start_window := v_pending_expected_bit IS NOT NULL
                                       AND v_received_bit <> v_pending_expected_bit
                                       AND v_pending_started_at IS NOT NULL
                                       AND v_pending_started_at > now() - interval '60 seconds'
                                       AND v_pending_is_protective_reset;
    END IF;
    v_preserve_local := COALESCE(v_eq.last_actuation_origin, '') = 'local'
                        AND v_received_bit IN ('0','1')
                        AND v_desired_matches_received
                        AND NOT (v_pending_confirms_expected AND NOT v_pending_is_protective_reset);
    v_local_no_recent_cmd := (
      (v_state_changed OR v_explicit_origin = 'local')
      AND NOT v_recent_cmd_90s
      AND NOT v_pending_command_active
      AND NOT v_recent_safety_expiry
    );
    IF v_pending_confirms_expected AND NOT v_pending_is_protective_reset THEN
      v_origin := 'remote';
    ELSIF v_local_no_recent_cmd THEN
      v_origin := 'local';
      v_blocked_until := now() + interval '30 seconds';
    ELSIF v_explicit_origin = 'local' AND NOT v_recent_safety_expiry AND NOT v_pending_command_active AND NOT v_desired_matches_received THEN
      v_origin := 'local';
      v_blocked_until := now() + interval '30 seconds';
    ELSIF v_state_changed AND NOT v_pending_command_active AND NOT v_recent_safety_expiry AND NOT v_desired_matches_received THEN
      v_origin := 'local';
      v_blocked_until := now() + interval '30 seconds';
    ELSIF v_received_bit IN ('0','1')
          AND NOT v_desired_matches_received
          AND NOT v_pending_command_active
          AND NOT v_recent_manual_cmd
          AND NOT v_recent_safety_expiry THEN
      v_origin := 'local';
      v_blocked_until := now() + interval '30 seconds';
    ELSIF COALESCE(v_eq.last_actuation_origin, '') = 'local'
          AND v_received_bit IN ('0','1')
          AND v_desired_matches_received THEN
      v_origin := 'remote';
    ELSIF COALESCE(v_eq.last_actuation_origin, '') = 'local' THEN
      v_origin := NULL;
    ELSIF v_explicit_origin = 'remote' THEN
      v_origin := 'remote';
    ELSE
      v_origin := NULL;
    END IF;
    IF _origin IS NULL THEN
      v_origin := NULL;
    END IF;
    IF v_received_bit IN ('0', '1') THEN
      IF v_local_no_recent_cmd THEN
        v_next_desired_running := NULL;
        v_clear_pending := false;
        v_enqueue_safety_off := false;
      ELSIF v_pending_confirms_expected THEN
        v_next_desired_running := v_pending_expected_bit = '1';
        v_clear_pending := true;
      ELSIF v_pending_within_start_window THEN
        v_next_desired_running := v_pending_expected_bit = '1';
        v_clear_pending := false;
      ELSIF v_pending_reset_still_waiting THEN
        v_next_desired_running := false;
        v_clear_pending := false;
        v_enqueue_safety_off := false;
        v_blocked_until := now() + interval '30 seconds';
      ELSIF v_pending_is_manual AND v_pending_expected_bit IS NOT NULL
            AND v_received_bit <> v_pending_expected_bit
            AND v_explicit_origin IS DISTINCT FROM 'local' THEN
        v_next_desired_running := v_pending_expected_bit = '1';
        v_clear_pending := false;
        v_enqueue_safety_off := false;
      ELSIF COALESCE(v_eq.last_actuation_origin, '') = 'local' AND NOT v_recent_safety_expiry THEN
        v_next_desired_running := NULL;
        v_blocked_until := COALESCE(v_eq.command_blocked_until, now() + interval '30 seconds');
      ELSE
        v_next_desired_running := NULL;
      END IF;
    END IF;
    UPDATE public.equipments e
    SET
      last_outputs_state = COALESCE(v_payload_to_store, e.last_outputs_state),
      last_communication = now(),
      last_signal_bars = COALESCE(_signal_bars, e.last_signal_bars),
      desired_running = COALESCE(v_next_desired_running, e.desired_running),
      last_actuation_origin = CASE
                                WHEN v_preserve_local THEN 'local'
                                ELSE COALESCE(_origin, v_origin, e.last_actuation_origin)
                              END,
      command_blocked_until = COALESCE(v_blocked_until, e.command_blocked_until),
      pending_command_id = CASE WHEN v_clear_pending THEN NULL ELSE e.pending_command_id END,
      updated_at = now()
    WHERE e.id = v_eq.id;
    IF v_state_changed AND v_new_running IS NOT NULL THEN
      INSERT INTO public.automation_log(
        farm_id, equipment_id, equipment_name, action, origin, result, actor_label,
        new_state, source_device, occurred_at, details, noise_reason
      ) VALUES (
        _farm_id, v_eq.id, v_eq.name,
        CASE WHEN v_new_running THEN 'pump_on'::public.event_action ELSE 'pump_off'::public.event_action END,
        CASE WHEN COALESCE(_origin, v_origin) = 'local' THEN 'local'::public.event_origin
             WHEN COALESCE(_origin, v_origin) = 'remote' THEN 'remote'::public.event_origin
             ELSE 'system'::public.event_origin END,
        'success'::public.event_result,
        CASE WHEN COALESCE(_origin, v_origin) = 'local' THEN 'Acionamento local' ELSE 'Telemetria RF' END,
        CASE WHEN v_new_running THEN 'on' ELSE 'off' END,
        'serial-bridge',
        now(),
        jsonb_build_object('payload', _payload, 'raw', _raw_response, 'origin', COALESCE(_origin, v_origin)),
        -- RUIDO DE RELATORIO (nao muda nada operacional):
        -- Se este RX e a confirmacao de um comando remoto correlacionavel por
        -- command_id + equipment_id + estado esperado, ele NAO e um acionamento
        -- novo: e a confirmacao do comando. O evento oficial dessa transicao e
        -- gravado por log_equipment_state_change via classify_physical_transition.
        -- Sem correlacao valida, noise_reason fica NULL e o acionamento LOCAL
        -- real continua oficial, exatamente como antes.
        CASE WHEN _command_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM public.commands c
                WHERE c.id = _command_id
                  AND c.farm_id = _farm_id
                  AND c.equipment_id = v_eq.id
                  AND ((c.frame LIKE '%{1}%' OR c.frame LIKE '%{01}%' OR c.frame LIKE '%{001}%'
                        OR c.frame LIKE '%{0001}%' OR c.frame LIKE '%{00001}%' OR c.frame LIKE '%{000001}%')
                       = v_new_running))
             THEN 'remote_command_confirmation_duplicate'
             ELSE NULL END
      );
    END IF;
    IF v_clear_pending AND v_eq.pending_command_id IS NOT NULL THEN
      UPDATE public.commands
      SET status = 'executed',
          response = COALESCE(response, _raw_response),
          responded_at = COALESCE(responded_at, now())
      WHERE id = v_eq.pending_command_id
        AND status IN ('pending', 'sent');
    END IF;
    IF v_enqueue_safety_off THEN
      PERFORM public.enqueue_reset_pump_command(_farm_id, v_eq.id, 'manual_60s_timeout');
    END IF;
  END LOOP;
  RETURN v_first_eq_id;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.attribute_scheduled_shutdown_log()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rule text;
  v_brt timestamp;
  v_now_min int;
  v_dow text;
BEGIN
  IF NEW.action IN ('pump_off', 'turn_off') AND NEW.origin IN ('local', 'system') THEN
    v_brt := (now() AT TIME ZONE 'America/Bahia');
    v_now_min := (extract(hour from v_brt)::int) * 60 + (extract(minute from v_brt)::int);
    v_dow := (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[(extract(dow from v_brt)::int) + 1];

    SELECT sa.name INTO v_rule
    FROM public.scheduled_automations sa
    WHERE sa.farm_id = NEW.farm_id AND sa.is_active = true
      AND v_dow = ANY(sa.days_of_week)
      AND v_now_min >= ((substring(sa.time_brt from '^([0-9]{1,2})')::int) * 60 + (substring(sa.time_brt from ':([0-9]{2})')::int)) - 5
      AND v_now_min <= ((substring(sa.time_brt from '^([0-9]{1,2})')::int) * 60 + (substring(sa.time_brt from ':([0-9]{2})')::int)) + 25
    LIMIT 1;

    IF v_rule IS NOT NULL THEN
      NEW.origin := 'auto';
      NEW.actor_label := v_rule;
    END IF;
  END IF;
  RETURN NEW;
END; $function$
;

CREATE OR REPLACE FUNCTION public.automation_attribution_rank(_origin event_origin, _user_id uuid, _source_device text, _actor text)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN _origin = 'whatsapp'::public.event_origin THEN 4
    WHEN _origin = 'remote'::public.event_origin
         AND (_user_id IS NOT NULL OR lower(COALESCE(_source_device,'')) LIKE 'whatsapp:%') THEN 4
    WHEN _origin = 'auto'::public.event_origin AND COALESCE(_actor,'') <> '' THEN 3
    WHEN _origin = 'auto'::public.event_origin THEN 3
    WHEN _origin = 'local'::public.event_origin THEN 2
    ELSE 1
  END;
$function$
;

CREATE OR REPLACE FUNCTION public.bump_automation_noise(_farm uuid, _equip uuid, _reason text)
 RETURNS void
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  INSERT INTO public.automation_log_noise_stats (farm_id, equipment_id, day, reason, hits)
  VALUES (_farm, _equip, current_date, _reason, 1)
  ON CONFLICT (farm_id, equipment_id, day, reason)
  DO UPDATE SET hits = public.automation_log_noise_stats.hits + 1, updated_at = now();
$function$
;

CREATE OR REPLACE FUNCTION public.classify_command_origin_kind(_source_device text, _created_by uuid)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT CASE
    WHEN lower(COALESCE(_source_device,'')) LIKE 'whatsapp%'        THEN 'whatsapp'
    WHEN lower(COALESCE(_source_device,'')) LIKE 'cloud-automation%' THEN 'automation'
    WHEN lower(COALESCE(_source_device,'')) LIKE 'backend-reset%'   THEN 'system'
    WHEN _created_by IS NOT NULL                                    THEN 'panel'
    ELSE 'system'
  END;
$function$
;

CREATE OR REPLACE FUNCTION public.classify_physical_transition(_equipment_id uuid, _farm_id uuid, _turning_on boolean, _at timestamp with time zone DEFAULT now(), _window interval DEFAULT '00:03:00'::interval)
 RETURNS TABLE(origin event_origin, actor_label text, user_id uuid, user_email text, command_id uuid, authorship_source text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_intent text; r record; v_rule text;
  v_saida int; v_wa text; v_act_origin text;
BEGIN
  v_intent := CASE WHEN _turning_on THEN 'turn_on' ELSE 'turn_off' END;
  SELECT COALESCE(saida,1), last_actuation_origin INTO v_saida, v_act_origin
    FROM public.equipments WHERE id = _equipment_id;

  -- ── (2) AUTOMAÇÃO COMPATÍVEL ────────────────────────────────────────────
  IF NOT _turning_on AND EXISTS (
       SELECT 1 FROM public.commands c
        WHERE c.equipment_id = _equipment_id
          AND c.source_device LIKE 'backend-reset:scheduled_shutdown%'
          AND c.created_at BETWEEN _at - interval '10 minutes' AND _at + interval '2 minutes')
  THEN
    SELECT NULLIF(btrim(e.last_changed_by),'') INTO v_rule
      FROM public.equipments e WHERE e.id = _equipment_id;
    RETURN QUERY SELECT 'auto'::public.event_origin,
      COALESCE(v_rule,'Desligamento Programado'), NULL::uuid, NULL::text,
      NULL::uuid, 'scheduled_command';
    RETURN;
  END IF;

  IF NOT _turning_on THEN
    SELECT sa.name INTO v_rule
      FROM public.scheduled_automations sa
     WHERE sa.farm_id = _farm_id AND sa.is_active
       AND sa.time_brt ~ '^[0-9]{1,2}:[0-9]{2}'
       AND (sa.days_of_week IS NULL OR array_length(sa.days_of_week,1) IS NULL
            OR (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[
                 extract(dow from (_at AT TIME ZONE 'America/Bahia'))::int + 1] = ANY(sa.days_of_week))
       AND (extract(hour from (_at AT TIME ZONE 'America/Bahia'))::int * 60
            + extract(minute from (_at AT TIME ZONE 'America/Bahia'))::int)
           BETWEEN ((substring(sa.time_brt from '^([0-9]{1,2})')::int)*60
                    + (substring(sa.time_brt from ':([0-9]{2})')::int)) - 5
               AND ((substring(sa.time_brt from '^([0-9]{1,2})')::int)*60
                    + (substring(sa.time_brt from ':([0-9]{2})')::int))
                   + (COALESCE(sa.max_retries,3) * COALESCE(sa.retry_interval_min,5)) + 5
     ORDER BY sa.time_brt LIMIT 1;
    IF v_rule IS NOT NULL THEN
      RETURN QUERY SELECT 'auto'::public.event_origin, v_rule,
        NULL::uuid, NULL::text, NULL::uuid, 'scheduled_window';
      RETURN;
    END IF;
  END IF;

  -- ── (3) COMANDO CORRELACIONADO — a evidência vem do próprio comando ─────
  -- commands é a fonte viva; command_audit é a cópia durável (o comando é
  -- apagado quando termina). A intenção sai do frame, não de rótulo gravado.
  WITH cand AS (
    SELECT c.id AS cid, c.created_at AS at, c.source_device AS src,
           c.created_by AS uid, c.frame AS frame
      FROM public.commands c
     WHERE c.equipment_id = _equipment_id
       AND c.type = 'manual'::public.command_type
       AND COALESCE(c.source_device,'') NOT LIKE 'backend-reset:%'
       AND c.created_at BETWEEN _at - _window AND _at + _window
    UNION ALL
    SELECT ca.command_id, ca.command_created_at, ca.source_device,
           ca.user_id, ca.frame
      FROM public.command_audit ca
     WHERE ca.equipment_id = _equipment_id
       AND COALESCE(ca.source_device,'') NOT LIKE 'backend-reset:%'
       AND ca.command_created_at BETWEEN _at - _window AND _at + _window
  )
  SELECT cand.cid, cand.src, cand.uid, p.full_name, p.email
    INTO r
    FROM cand LEFT JOIN public.profiles p ON p.id = cand.uid
   WHERE COALESCE(public.command_intent_from_frame(cand.frame, v_saida), v_intent) = v_intent
   ORDER BY (public.command_intent_from_frame(cand.frame, v_saida) IS NULL),
            abs(extract(epoch FROM (cand.at - _at)))
   LIMIT 1;

  IF FOUND THEN
    -- WhatsApp: o operador real está em source_device, não em created_by.
    IF lower(COALESCE(r.src,'')) LIKE 'whatsapp:%' THEN
      v_wa := btrim(split_part(substr(r.src, strpos(r.src, ':') + 1), '|', 1));
      -- só dígitos/pontuação = telefone; telefone não é nome e não vai à tela
      IF v_wa ~ '^[+0-9 ()\-]*$' THEN v_wa := NULL; END IF;
      RETURN QUERY SELECT 'whatsapp'::public.event_origin,
        COALESCE(NULLIF(v_wa,''), r.full_name, r.email),
        r.uid, r.email, r.cid, 'whatsapp_source_device';
      RETURN;
    END IF;
    IF r.uid IS NOT NULL THEN
      RETURN QUERY SELECT 'remote'::public.event_origin,
        COALESCE(r.full_name, r.email), r.uid, r.email, r.cid, 'command_created_by';
      RETURN;
    END IF;
  END IF;

  -- ── (4) SEM CORRELAÇÃO ──────────────────────────────────────────────────
  -- Local só com evidência: a telemetria precisa ter declarado atuação local.
  IF lower(COALESCE(v_act_origin,'')) = 'local' THEN
    RETURN QUERY SELECT 'local'::public.event_origin, 'Acionamento local',
      NULL::uuid, NULL::text, NULL::uuid, 'local_declared';
    RETURN;
  END IF;

  -- Transição observada sem origem comprovada. Entra no histórico como tal.
  RETURN QUERY SELECT 'system'::public.event_origin, NULL::text,
    NULL::uuid, NULL::text, NULL::uuid, 'unidentified';
END; $function$
;

CREATE OR REPLACE FUNCTION public.command_intent_from_frame(_frame text, _saida integer)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE v_payload text; v_bit text; v_idx int;
BEGIN
  v_payload := substring(COALESCE(_frame,'') from '\{([01]+)\}');
  IF v_payload IS NULL THEN RETURN NULL; END IF;

  IF length(v_payload) = 1 THEN
    v_bit := v_payload;                       -- PLC de uma saída
  ELSE
    v_idx := COALESCE(_saida, 0);
    IF v_idx < 1 OR v_idx > length(v_payload) THEN RETURN NULL; END IF;
    v_bit := substring(v_payload from v_idx for 1);
  END IF;

  RETURN CASE v_bit WHEN '1' THEN 'turn_on' WHEN '0' THEN 'turn_off' ELSE NULL END;
END; $function$
;

CREATE OR REPLACE FUNCTION public.enforce_automation_log_actor_rule()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Permite explicitamente automações da nuvem (têm origem identificada e auditada).
  IF NEW.source_device IS NOT NULL AND NEW.source_device LIKE 'cloud-%' THEN
    RETURN NEW;
  END IF;

  -- Bloqueia remote sem user_id real → comando fantasma/bug.
  IF NEW.origin = 'remote'::public.event_origin AND NEW.user_id IS NULL THEN
    -- Se veio do agente serial, reclassifica como acionamento local
    -- (PLC reportou mudança de estado sem comando humano = local).
    IF NEW.source_device IS NOT NULL AND NEW.source_device LIKE 'serial-bridge%' THEN
      NEW.origin := 'local'::public.event_origin;
      RETURN NEW;
    END IF;
    -- Caso contrário, descarta o insert silenciosamente.
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.enqueue_reset_pump_command(_farm_id uuid, _equipment_id uuid, _reason text DEFAULT 'manual_reset'::text)
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

  -- ── MIGRATION AWARENESS (fail-closed por padrão) ──────────────────────────
  -- Esta função ENFILEIRA COMANDO FÍSICO (TX 0). Chamada de nuvem para uma
  -- fazenda que não é operacional neste backend seria atuação cruzada.
  --
  -- A exceção é estreita e proposital: `local_shutdown_detected` e
  -- `manual_60s_timeout` nascem do processamento do RX do PRÓPRIO Agent
  -- (guard_unexpected_pump_shutdown e apply_pump_telemetry). Se a telemetria
  -- chegou até aqui, este É o backend do Agent — e bloquear justamente aí
  -- derrubaria uma proteção física na janela entre set_backend e promoção,
  -- que é quando ela mais importa.
  --
  -- Todo o resto é bloqueado por padrão: scheduled_shutdown_*, manual_reset,
  -- turn_on_timeout e qualquer motivo novo que venha a existir. Um chamador
  -- futuro entra protegido sem precisar lembrar de nada.
  IF COALESCE(_reason, '') NOT IN ('local_shutdown_detected', 'manual_60s_timeout')
     AND NOT public.farm_is_operational_here(_farm_id) THEN
    RAISE EXCEPTION
      'Fazenda % não é operacional neste backend — reset (%) recusado',
      _farm_id, _reason;
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

  v_total := COALESCE(v_eq.plc_total, 1);
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
$function$
;

CREATE OR REPLACE FUNCTION public.guard_official_report_row()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.noise_reason IS NOT NULL THEN RETURN NEW; END IF;

  IF NEW.action NOT IN ('turn_on','turn_off','pump_on','pump_off') THEN
    NEW.noise_reason := 'technical_not_a_transition'; RETURN NEW;
  END IF;
  IF NEW.origin = 'reading'::public.event_origin THEN
    NEW.noise_reason := 'technical_not_a_transition'; RETURN NEW;
  END IF;
  IF NEW.equipment_id IS NULL THEN
    NEW.noise_reason := 'no_equipment'; RETURN NEW;
  END IF;

  IF NEW.result IS DISTINCT FROM 'success'::public.event_result
     AND COALESCE(NEW.details->>'state_confirmed','') <> 'true' THEN
    NEW.noise_reason := 'command_not_confirmed'; RETURN NEW;
  END IF;

  -- ANTES: origin='system' virava 'local' + 'Acionamento local'. Isso afirmava
  -- acionamento humano no painel sem nenhuma prova. Agora a linha permanece
  -- 'system' — transição real, origem não identificada — e segue sem autor.
  IF NEW.origin = 'system'::public.event_origin THEN
    NEW.details := COALESCE(NEW.details,'{}'::jsonb)
                   || jsonb_build_object('unidentified_origin', true);
    RETURN NEW;
  END IF;

  IF public.is_technical_actor_label(NEW.actor_label) THEN
    IF NEW.origin = 'local'::public.event_origin THEN
      NEW.actor_label := 'Acionamento local';
    ELSE
      NEW.actor_label := NULL;
    END IF;
    NEW.details := COALESCE(NEW.details,'{}'::jsonb)
                   || jsonb_build_object('technical_label_stripped', true);
  END IF;

  IF NEW.origin = 'local'::public.event_origin
     AND COALESCE(btrim(NEW.actor_label),'') = '' THEN
    NEW.actor_label := 'Acionamento local';
  END IF;

  RETURN NEW;
END; $function$
;

CREATE OR REPLACE FUNCTION public.is_technical_actor_label(_label text)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  SELECT lower(btrim(COALESCE(_label,''))) ~
         '^(telemetria|telemetria rf|rf|agent|agente|serial|serial-bridge|bridge|system|sistema|cloud|auto-trigger)([ -].*)?$';
$function$
;

CREATE OR REPLACE FUNCTION public.log_equipment_state_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_saida_idx int; v_old boolean; v_new boolean;
  v_action public.event_action; c record; v_at timestamptz;
BEGIN
  IF NEW.type NOT IN ('poco','bombeamento') THEN RETURN NEW; END IF;

  v_saida_idx := COALESCE(NEW.saida, 1);

  -- ── (1) HOUVE TRANSIÇÃO FÍSICA? Sem transição, nada de linha oficial. ──
  IF OLD.last_outputs_state ~ '^[01]{6}$' AND v_saida_idx BETWEEN 1 AND 6 THEN
    v_old := substring(OLD.last_outputs_state from v_saida_idx for 1) = '1';
  ELSIF OLD.last_outputs_state ~ '^[01]$' THEN
    v_old := OLD.last_outputs_state = '1';
  ELSE v_old := NULL; END IF;

  IF NEW.last_outputs_state ~ '^[01]{6}$' AND v_saida_idx BETWEEN 1 AND 6 THEN
    v_new := substring(NEW.last_outputs_state from v_saida_idx for 1) = '1';
  ELSIF NEW.last_outputs_state ~ '^[01]$' THEN
    v_new := NEW.last_outputs_state = '1';
  ELSE v_new := NULL; END IF;

  -- leitura repetida do mesmo estado: NUNCA entra
  IF v_new IS NULL OR v_old IS NOT DISTINCT FROM v_new THEN RETURN NEW; END IF;

  v_action := CASE WHEN v_new THEN 'turn_on'::public.event_action
                   ELSE 'turn_off'::public.event_action END;
  v_at := COALESCE(NEW.last_communication, now());

  -- ── (2)(3)(4) CLASSIFICA ANTES DE GRAVAR ──────────────────────────────
  SELECT * INTO c FROM public.classify_physical_transition(
    NEW.id, NEW.farm_id, v_new, v_at);

  INSERT INTO public.automation_log (
    farm_id, equipment_id, equipment_name, occurred_at, origin, action, result,
    new_state, client_event_id, source_device,
    user_id, user_email, actor_label, noise_reason, details)
  VALUES (
    NEW.farm_id, NEW.id, NEW.name, v_at, c.origin, v_action,
    'success'::public.event_result, NEW.last_outputs_state,
    gen_random_uuid(), 'auto-trigger',
    c.user_id, c.user_email, c.actor_label,
    NULL,                       -- transição física confirmada É oficial
    jsonb_build_object(
      'actuation_origin', NEW.last_actuation_origin,
      'authorship_source', c.authorship_source,
      'command_id', c.command_id,
      'confirmation_method', 'telemetria_rf'));   -- técnico, só em details

  RETURN NEW;
END; $function$
;

CREATE OR REPLACE FUNCTION public.log_manual_command_to_automation_log()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_equipment_name text;
  v_saida int;
  v_outs text;
  v_running boolean;
  v_state_ok boolean := false;
  v_action public.event_action;
  v_email text;
  v_details jsonb;
  v_origin public.event_origin;
  v_actor_label text;
  v_result public.event_result;
BEGIN
  IF NEW.type <> 'manual'::public.command_type
     OR NEW.status NOT IN ('executed'::public.command_status, 'timeout'::public.command_status, 'error'::public.command_status)
     OR OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;

  SELECT name, COALESCE(saida, 1), last_outputs_state
    INTO v_equipment_name, v_saida, v_outs
    FROM public.equipments
   WHERE id = NEW.equipment_id;

  IF NEW.created_by IS NULL THEN
    v_origin := 'system'::public.event_origin;
    v_actor_label := 'Sistema (proteção automática)';
    v_email := NULL;
  ELSE
    v_origin := 'remote'::public.event_origin;
    v_actor_label := NULL;
    SELECT email INTO v_email FROM public.profiles WHERE id = NEW.created_by;
  END IF;

  v_action := CASE
    WHEN NEW.frame LIKE '%{1}%' OR NEW.frame LIKE '%{01}%' OR NEW.frame LIKE '%{001}%' OR NEW.frame LIKE '%{0001}%' OR NEW.frame LIKE '%{00001}%' OR NEW.frame LIKE '%{000001}%'
      THEN 'turn_on'::public.event_action
    ELSE 'turn_off'::public.event_action
  END;

  IF v_outs ~ '^[01]{6}$' AND v_saida BETWEEN 1 AND 6 THEN
    v_running := substring(v_outs from v_saida for 1) = '1';
  ELSIF v_outs ~ '^[01]$' THEN
    v_running := v_outs = '1';
  ELSE
    v_running := NULL;
  END IF;
  v_state_ok := (v_running IS NOT NULL)
                AND (v_running = (v_action = 'turn_on'::public.event_action));

  IF NEW.status = 'executed'::public.command_status OR v_state_ok THEN
    v_result := 'success'::public.event_result;
  ELSE
    v_result := 'fail'::public.event_result;
  END IF;

  v_details := jsonb_build_object(
    'type', 'manual',
    'command_id', NEW.id,
    'frame', NEW.frame,
    'systemic', NEW.created_by IS NULL,
    'error_message', NEW.error_message,
    'command_status', NEW.status,
    'state_confirmed', v_state_ok
  );

  INSERT INTO public.automation_log (
    farm_id, user_id, user_email, equipment_id, equipment_name,
    action, origin, actor_label, result, occurred_at, source_device, details, client_event_id,
    noise_reason
  ) VALUES (
    NEW.farm_id, NEW.created_by, v_email, NEW.equipment_id, COALESCE(v_equipment_name, 'Equipamento'),
    v_action, v_origin, v_actor_label, v_result,
    COALESCE(NEW.responded_at, NEW.sent_at, NEW.created_at, now()),
    NEW.source_device, v_details, NEW.client_event_id,
    -- RUIDO DE RELATORIO: quando o comando foi EXECUTADO com sucesso, a
    -- transicao fisica oficial ja e gravada por log_equipment_state_change
    -- (com command_id e autoria). Este registro vira intencao/resultado
    -- tecnico e sai do relatorio operacional — mas CONTINUA na tabela, com
    -- user_id, source_device e details intactos.
    -- timeout/error NAO sao marcados: falha operacional tem de permanecer
    -- auditavel e visivel.
    CASE WHEN NEW.status = 'executed'::public.command_status
              AND v_result = 'success'::public.event_result
         THEN 'remote_command_intent'
         ELSE NULL END
  )
  ON CONFLICT (farm_id, client_event_id) DO NOTHING;

  RETURN NEW;
END;
$function$
;

CREATE OR REPLACE FUNCTION public.resolve_automation_actor_label(_user_id uuid, _user_email text, _origin event_origin, _details jsonb, _source_device text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_full_name text;
  v_profile_email text;
  v_details_name text;
BEGIN
  IF _user_id IS NOT NULL THEN
    SELECT NULLIF(btrim(full_name), ''), NULLIF(btrim(email), '')
      INTO v_full_name, v_profile_email
    FROM public.profiles WHERE id = _user_id;
    RETURN COALESCE(v_full_name, v_profile_email, NULLIF(btrim(_user_email), ''), 'Usuário');
  END IF;

  IF NULLIF(btrim(_user_email), '') IS NOT NULL THEN
    RETURN btrim(_user_email);
  END IF;

  v_details_name := NULLIF(btrim((_details->>'user_name')), '');
  IF v_details_name IS NOT NULL THEN
    RETURN v_details_name;
  END IF;

  IF COALESCE(_source_device, '') IN ('cloud-automation', 'cloud-protective-off')
     OR _origin = 'auto'::public.event_origin THEN
    RETURN 'Automação';
  END IF;

  -- Sistema/agente e local sem identificação → "Sistema"
  RETURN 'Sistema';
END;
$function$
;

CREATE OR REPLACE FUNCTION public.set_automation_actor_label()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Preserve any meaningful pre-filled label (except the legacy placeholder)
  IF NEW.actor_label IS NOT NULL
     AND btrim(NEW.actor_label) <> ''
     AND NEW.actor_label <> 'Acionamento Local' THEN
    RETURN NEW;
  END IF;

  IF NEW.origin = 'remote'::public.event_origin THEN
    IF NEW.user_id IS NOT NULL THEN
      NEW.actor_label := COALESCE(
        (SELECT NULLIF(btrim(full_name), '') FROM public.profiles WHERE id = NEW.user_id),
        NULLIF(btrim(NEW.user_email), ''),
        'Comando Remoto'
      );
    ELSE
      NEW.actor_label := COALESCE(NULLIF(btrim(NEW.user_email), ''), 'Comando Remoto');
    END IF;
  ELSIF NEW.origin = 'auto'::public.event_origin THEN
    NEW.actor_label := 'Automação';
  ELSE
    -- local / system / reading / qualquer outro
    NEW.actor_label := 'Sistema';
  END IF;

  RETURN NEW;
END;
$function$
;

