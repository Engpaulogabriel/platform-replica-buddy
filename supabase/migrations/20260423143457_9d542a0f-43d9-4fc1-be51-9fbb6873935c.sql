CREATE OR REPLACE FUNCTION public.sync_equipment_pending_command_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.type = 'manual' AND NEW.equipment_id IS NOT NULL THEN
    UPDATE public.equipments
    SET pending_command_id = NEW.id,
        updated_at = now()
    WHERE id = NEW.equipment_id
      AND farm_id = NEW.farm_id;

    UPDATE public.commands
    SET status = 'cancelled',
        responded_at = now(),
        error_message = 'Polling cancelado por comando manual em andamento'
    WHERE farm_id = NEW.farm_id
      AND type = 'polling'
      AND status = 'pending'
      AND (
        equipment_id = NEW.equipment_id
        OR (NEW.plc_hw_id IS NOT NULL AND plc_hw_id = NEW.plc_hw_id)
      );
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_equipment_pending_command_on_update()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.type = 'manual'
     AND NEW.equipment_id IS NOT NULL
     AND NEW.status IN ('error', 'timeout', 'cancelled') THEN
    UPDATE public.equipments
    SET pending_command_id = NULL,
        updated_at = now()
    WHERE id = NEW.equipment_id
      AND farm_id = NEW.farm_id
      AND pending_command_id = NEW.id;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_equipment_pending_command_on_insert ON public.commands;
CREATE TRIGGER trg_sync_equipment_pending_command_on_insert
AFTER INSERT ON public.commands
FOR EACH ROW
EXECUTE FUNCTION public.sync_equipment_pending_command_on_insert();

DROP TRIGGER IF EXISTS trg_sync_equipment_pending_command_on_update ON public.commands;
CREATE TRIGGER trg_sync_equipment_pending_command_on_update
AFTER UPDATE OF status ON public.commands
FOR EACH ROW
EXECUTE FUNCTION public.sync_equipment_pending_command_on_update();

CREATE OR REPLACE FUNCTION public.enqueue_polling_for_due_equipments(_farm_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_count integer := 0;
  v_eq RECORD;
  v_tsnn text;
  v_payload text;
  v_frame text;
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  FOR v_eq IN
    SELECT e.id, e.hw_id, e.type, e.saida, e.last_outputs_state,
           e.polling_interval_seconds, e.last_polling_at,
           e.pending_command_id,
           pg.hw_id AS plc_hw_id
    FROM public.equipments e
    LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
    WHERE e.farm_id = _farm_id
      AND e.active = true
      AND e.type IN ('poco', 'bombeamento')
      AND e.pending_command_id IS NULL
      AND (
        e.last_polling_at IS NULL
        OR e.last_polling_at < now() - (e.polling_interval_seconds || ' seconds')::interval
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.commands c
        WHERE c.equipment_id = e.id
          AND c.status = 'pending'
          AND c.type = 'polling'
      )
  LOOP
    v_tsnn := COALESCE(NULLIF(v_eq.plc_hw_id, ''), substring(v_eq.hw_id from 1 for 4));

    IF v_eq.type = 'poco' THEN
      v_payload := '';
    ELSE
      v_payload := COALESCE(NULLIF(v_eq.last_outputs_state, ''), '000000');
      IF v_payload !~ '^[01]{6}$' THEN
        v_payload := '000000';
      END IF;
    END IF;

    v_frame := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';

    INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device)
    VALUES (_farm_id, v_eq.id, v_tsnn, 'polling', 5, v_frame, 8000, 'platform-scheduler');

    UPDATE public.equipments SET last_polling_at = now() WHERE id = v_eq.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_pump_telemetry(_farm_id uuid, _tsnn text, _payload text, _signal_bars smallint DEFAULT NULL::smallint, _command_id uuid DEFAULT NULL::uuid, _raw_response text DEFAULT NULL::text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_eq_id uuid;
  v_eq_saida smallint;
  v_eq_pending uuid;
  v_old_state text;
  v_new_running boolean;
  v_old_running boolean;
  v_payload_safe text;
  v_origin text;
  v_blocked_until timestamptz;
  v_state_changed boolean;
  v_recent_remote_command_at timestamptz;
  v_pending_frame text;
  v_pending_payload text;
  v_pending_is_manual boolean := false;
  v_pending_confirms_expected boolean := false;
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  SELECT id, COALESCE(saida, 1), pending_command_id, last_outputs_state
    INTO v_eq_id, v_eq_saida, v_eq_pending, v_old_state
  FROM public.equipments
  WHERE farm_id = _farm_id
    AND substring(hw_id from 1 for 4) = _tsnn
  LIMIT 1;

  IF v_eq_id IS NULL THEN
    RETURN NULL;
  END IF;

  IF _payload IS NULL THEN
    v_payload_safe := NULL;
  ELSIF _payload ~ '^[01]{6}$' THEN
    v_payload_safe := _payload;
  ELSIF _payload ~ '^[01]$' AND v_eq_saida BETWEEN 1 AND 6 THEN
    v_payload_safe := overlay('000000' placing _payload from v_eq_saida::int for 1);
  ELSIF _payload = '' THEN
    v_payload_safe := NULL;
  ELSE
    v_payload_safe := NULL;
  END IF;

  v_state_changed := false;
  v_origin := NULL;
  v_blocked_until := NULL;

  IF v_payload_safe IS NOT NULL AND v_old_state IS NOT NULL
     AND v_old_state ~ '^[01]{6}$' THEN
    BEGIN
      v_new_running := substring(v_payload_safe from v_eq_saida::int for 1) = '1';
      v_old_running := substring(v_old_state from v_eq_saida::int for 1) = '1';
      v_state_changed := v_new_running IS DISTINCT FROM v_old_running;
    EXCEPTION WHEN OTHERS THEN
      v_state_changed := false;
    END;
  END IF;

  IF v_eq_pending IS NOT NULL THEN
    SELECT frame, type = 'manual'
      INTO v_pending_frame, v_pending_is_manual
    FROM public.commands
    WHERE id = v_eq_pending
      AND farm_id = _farm_id
    LIMIT 1;

    IF v_pending_is_manual AND v_payload_safe IS NOT NULL AND v_pending_frame IS NOT NULL THEN
      v_pending_payload := substring(v_pending_frame from '\{([01]{1,6})\}');
      IF v_pending_payload ~ '^[01]$' THEN
        v_pending_confirms_expected := substring(v_payload_safe from v_eq_saida::int for 1) = v_pending_payload;
      ELSIF v_pending_payload ~ '^[01]{6}$' THEN
        v_pending_confirms_expected := substring(v_payload_safe from v_eq_saida::int for 1) = substring(v_pending_payload from v_eq_saida::int for 1);
      END IF;
    END IF;
  END IF;

  IF v_state_changed THEN
    IF v_pending_confirms_expected OR _command_id = v_eq_pending THEN
      v_origin := 'remote';
    ELSIF _command_id IS NOT NULL THEN
      v_origin := 'remote';
    ELSE
      SELECT MAX(sent_at) INTO v_recent_remote_command_at
      FROM public.commands
      WHERE equipment_id = v_eq_id
        AND type = 'manual'
        AND sent_at > now() - interval '60 seconds';

      IF v_recent_remote_command_at IS NOT NULL THEN
        v_origin := 'remote';
      ELSE
        v_origin := 'local';
        v_blocked_until := now() + interval '30 seconds';
      END IF;
    END IF;
  END IF;

  UPDATE public.equipments
  SET
    last_communication = now(),
    last_signal_bars = COALESCE(_signal_bars, last_signal_bars),
    last_outputs_state = COALESCE(v_payload_safe, last_outputs_state),
    last_actuation_origin = COALESCE(v_origin, last_actuation_origin),
    command_blocked_until = COALESCE(v_blocked_until, command_blocked_until),
    pending_command_id = CASE
      WHEN v_pending_confirms_expected THEN NULL
      WHEN _command_id IS NOT NULL AND pending_command_id = _command_id AND v_pending_confirms_expected THEN NULL
      ELSE pending_command_id
    END,
    updated_at = now()
  WHERE id = v_eq_id;

  IF _command_id IS NOT NULL THEN
    UPDATE public.commands
    SET status = 'executed',
        responded_at = now(),
        response = COALESCE(_raw_response, response)
    WHERE id = _command_id AND farm_id = _farm_id;
  END IF;

  RETURN v_eq_id;
END;
$function$;