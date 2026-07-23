-- ============================================================
-- 1) Novos campos em equipments
-- ============================================================
ALTER TABLE public.equipments
  ADD COLUMN IF NOT EXISTS last_actuation_origin text,
  ADD COLUMN IF NOT EXISTS command_blocked_until timestamptz,
  ADD COLUMN IF NOT EXISTS pending_command_id uuid;

-- Default polling 8s (era 5s). Equipamentos antigos com 5s sao migrados
-- via SQL direto (bypass do trigger de operator) usando a mesma SECURITY DEFINER.
ALTER TABLE public.equipments
  ALTER COLUMN polling_interval_seconds SET DEFAULT 8;

-- ============================================================
-- 2) Atualizar trigger para permitir os 3 campos novos como telemetria
-- ============================================================
CREATE OR REPLACE FUNCTION public.equipments_writer_telemetry_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Admin/owner da fazenda: libera tudo
  IF public.is_farm_admin(auth.uid(), NEW.farm_id) THEN
    RETURN NEW;
  END IF;

  -- Operator: so pode atualizar campos de telemetria
  IF NEW.farm_id IS DISTINCT FROM OLD.farm_id
     OR NEW.hw_id IS DISTINCT FROM OLD.hw_id
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.latitude IS DISTINCT FROM OLD.latitude
     OR NEW.longitude IS DISTINCT FROM OLD.longitude
     OR NEW.max_height IS DISTINCT FROM OLD.max_height
     OR NEW.alarm_low IS DISTINCT FROM OLD.alarm_low
     OR NEW.alarm_high IS DISTINCT FROM OLD.alarm_high
     OR NEW.sector_id IS DISTINCT FROM OLD.sector_id
     OR NEW.plc_group_id IS DISTINCT FROM OLD.plc_group_id
     OR NEW.active IS DISTINCT FROM OLD.active
     OR NEW.firmware_version IS DISTINCT FROM OLD.firmware_version
     OR NEW.saida IS DISTINCT FROM OLD.saida
     OR NEW.horas_pico IS DISTINCT FROM OLD.horas_pico
     OR NEW.max_horas_dia IS DISTINCT FROM OLD.max_horas_dia
     OR NEW.demanda_kw IS DISTINCT FROM OLD.demanda_kw
     OR NEW.fonte_tipo IS DISTINCT FROM OLD.fonte_tipo
     OR NEW.alimenta_id IS DISTINCT FROM OLD.alimenta_id
     OR NEW.polling_interval_seconds IS DISTINCT FROM OLD.polling_interval_seconds
  THEN
    RAISE EXCEPTION 'operator pode atualizar apenas campos de telemetria do equipamento';
  END IF;

  -- last_actuation_origin, command_blocked_until, pending_command_id sao
  -- considerados telemetria (escritos pelo agent / RPC) -> liberados.
  RETURN NEW;
END;
$function$;

-- ============================================================
-- 3) Migrar equipamentos antigos com 5s -> 8s (bypass trigger via session_replication_role)
--    Usamos uma funcao SECURITY DEFINER one-shot.
-- ============================================================
DO $migration$
BEGIN
  -- Desabilita triggers de usuario temporariamente (so este statement)
  SET LOCAL session_replication_role = 'replica';
  UPDATE public.equipments
     SET polling_interval_seconds = 8
   WHERE polling_interval_seconds = 5;
END;
$migration$;

-- ============================================================
-- 4) Polling hibrido: {} para poco, {XXXXXX} para bombeamento
-- ============================================================
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
           pg.hw_id AS plc_hw_id
    FROM public.equipments e
    LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
    WHERE e.farm_id = _farm_id
      AND e.active = true
      AND e.type IN ('poco', 'bombeamento')
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
      -- POCO: polling com COXETE VAZIO (especificacao Manus).
      -- Bomba responde com seu estado atual sem alterar nada.
      v_payload := '';
    ELSE
      -- BOMBEAMENTO (PLC multi-saida): mantem payload de 6 digitos
      -- com o estado atual conhecido. Trocar essa logica quebraria
      -- bombas que compartilham o mesmo PLC.
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

-- ============================================================
-- 5) apply_pump_telemetry com deteccao Local vs Remoto
-- ============================================================
CREATE OR REPLACE FUNCTION public.apply_pump_telemetry(
  _farm_id uuid,
  _tsnn text,
  _payload text,
  _signal_bars smallint DEFAULT NULL::smallint,
  _command_id uuid DEFAULT NULL::uuid,
  _raw_response text DEFAULT NULL::text
)
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
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  -- Localiza equipamento pelo prefixo de hw_id (TSNN = 4 primeiros digitos)
  SELECT id, COALESCE(saida, 1), pending_command_id, last_outputs_state
    INTO v_eq_id, v_eq_saida, v_eq_pending, v_old_state
  FROM public.equipments
  WHERE farm_id = _farm_id
    AND substring(hw_id from 1 for 4) = _tsnn
  LIMIT 1;

  IF v_eq_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Sanitiza/normaliza payload conforme tipo
  IF _payload IS NULL THEN
    v_payload_safe := NULL;
  ELSIF _payload ~ '^[01]{6}$' THEN
    v_payload_safe := _payload;
  ELSIF _payload ~ '^[01]$' AND v_eq_saida BETWEEN 1 AND 6 THEN
    v_payload_safe := overlay('000000' placing _payload from v_eq_saida::int for 1);
  ELSIF _payload = '' THEN
    -- Resposta vazia (eco do polling com {} antes de bomba responder).
    -- Nao atualiza estado, so registra last_communication.
    v_payload_safe := NULL;
  ELSE
    v_payload_safe := NULL;
  END IF;

  -- Detecta mudanca de estado da saida especifica
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

  -- Classifica origem:
  --   _command_id presente -> REMOTO
  --   espontaneo + sem comando recente (60s) -> LOCAL (bloqueia 30s)
  IF v_state_changed THEN
    IF _command_id IS NOT NULL THEN
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
      WHEN _command_id IS NOT NULL AND pending_command_id = _command_id THEN NULL
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

-- ============================================================
-- 6) Funcao auxiliar: front chama quando timer 60s expira sem obediencia
-- ============================================================
CREATE OR REPLACE FUNCTION public.mark_pump_local_actuation(
  _equipment_id uuid,
  _farm_id uuid
)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  UPDATE public.equipments
  SET last_actuation_origin = 'local',
      command_blocked_until = now() + interval '30 seconds',
      pending_command_id = NULL,
      updated_at = now()
  WHERE id = _equipment_id
    AND farm_id = _farm_id;

  RETURN FOUND;
END;
$function$;