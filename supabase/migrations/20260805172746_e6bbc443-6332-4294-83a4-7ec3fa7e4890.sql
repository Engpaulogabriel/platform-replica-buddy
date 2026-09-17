-- 1) Tabela de logs de sistema
CREATE TABLE IF NOT EXISTS public.system_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  level text NOT NULL DEFAULT 'info',
  source text,
  message text NOT NULL,
  farm_id uuid,
  context jsonb
);

CREATE INDEX IF NOT EXISTS system_logs_farm_created_idx ON public.system_logs (farm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS system_logs_created_idx ON public.system_logs (created_at DESC);

GRANT SELECT ON public.system_logs TO authenticated;
GRANT ALL ON public.system_logs TO service_role;

ALTER TABLE public.system_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Platform staff can read system logs" ON public.system_logs;
CREATE POLICY "Platform staff can read system logs"
ON public.system_logs FOR SELECT TO authenticated
USING (public.is_platform_staff(auth.uid()));

-- 2) apply_level_telemetry: loga descartes
CREATE OR REPLACE FUNCTION public.apply_level_telemetry(_farm_id uuid, _plc_hw_id text, _sensor_index smallint, _raw_value integer, _raw_response text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_eq_id uuid;
  v_plc   text := upper(left(coalesce(_plc_hw_id, ''), 4));
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  IF _sensor_index NOT IN (1, 2) THEN
    RAISE EXCEPTION 'sensor_index invalido: %', _sensor_index;
  END IF;

  SELECT e.id INTO v_eq_id
  FROM public.equipments e
  LEFT JOIN public.plc_groups p ON p.id = e.plc_group_id
  WHERE e.farm_id = _farm_id
    AND e.type = 'nivel'
    AND (
      (e.plc_group_id IS NOT NULL AND upper(p.hw_id) = v_plc)
      OR upper(left(coalesce(e.hw_id, ''), 4)) = v_plc
    )
    AND e.level_sensor_index = _sensor_index
  ORDER BY e.created_at ASC
  LIMIT 1;

  IF v_eq_id IS NULL THEN
    SELECT e.id INTO v_eq_id
    FROM public.equipments e
    LEFT JOIN public.plc_groups p ON p.id = e.plc_group_id
    WHERE e.farm_id = _farm_id
      AND e.type = 'nivel'
      AND (
        (e.plc_group_id IS NOT NULL AND upper(p.hw_id) = v_plc)
        OR upper(left(coalesce(e.hw_id, ''), 4)) = v_plc
      )
      AND e.level_sensor_index IS NULL
    ORDER BY e.created_at ASC
    OFFSET (_sensor_index - 1)
    LIMIT 1;
  END IF;

  IF v_eq_id IS NULL THEN
    INSERT INTO public.system_logs(level, source, message, farm_id, context)
    VALUES (
      'warning',
      'apply_level_telemetry',
      'Leitura de nivel descartada: PLC ' || coalesce(_plc_hw_id, '?') ||
      ' sensor_index ' || _sensor_index || ' nao encontrou equipamento correspondente',
      _farm_id,
      jsonb_build_object('plc_hw_id', _plc_hw_id, 'sensor_index', _sensor_index,
                         'raw_value', _raw_value, 'raw_response', _raw_response)
    );
    RETURN NULL;
  END IF;

  UPDATE public.equipments
     SET level_last_raw = _raw_value,
         level_last_raw_at = now(),
         level_sensor_index = _sensor_index,
         last_communication = now()
   WHERE id = v_eq_id;

  RETURN v_eq_id;
END;
$function$;

-- 3) Polling com ate 3 tentativas por PLC (vale para poco, bombeamento e nivel)
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
  v_frame text;
  v_first_eq_id uuid;
  v_force_tsnn text;
  v_retry int := 0;
BEGIN
  IF public.is_farm_in_maintenance(_farm_id) THEN
    RETURN 0;
  END IF;

  DELETE FROM public.commands
  WHERE farm_id = _farm_id
    AND status = 'pending'
    AND type = 'polling'
    AND created_at < now() - interval '30 seconds';

  -- Marca timeouts e captura o PLC que falhou para retry (max 3 tentativas)
  WITH t AS (
    UPDATE public.commands
    SET status = 'timeout',
        responded_at = now(),
        error_message = 'Sem resposta dentro do timeout'
    WHERE farm_id = _farm_id
      AND status = 'sent'
      AND type = 'polling'
      AND sent_at < now() - (GREATEST(timeout_ms, 13000) || ' milliseconds')::interval
    RETURNING plc_hw_id, COALESCE(retry_count, 0) AS rc
  )
  SELECT t.plc_hw_id, t.rc INTO v_force_tsnn, v_retry
  FROM t
  ORDER BY t.rc ASC
  LIMIT 1;

  IF v_force_tsnn IS NULL OR v_retry >= 2 THEN
    v_force_tsnn := NULL;
    v_retry := 0;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.commands c
    WHERE c.farm_id = _farm_id
      AND c.status IN ('pending', 'sent')
      AND c.type = 'polling'
  ) THEN
    RETURN 0;
  END IF;

  IF v_force_tsnn IS NULL AND EXISTS (
    SELECT 1 FROM public.commands c
    WHERE c.farm_id = _farm_id
      AND c.type = 'polling'
      AND c.source_device = 'platform-scheduler'
      AND c.created_at > now() - interval '10 seconds'
  ) THEN
    RETURN 0;
  END IF;

  SELECT
    COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) AS tsnn,
    MIN(e.last_polling_at) AS oldest_polling_at,
    MAX(COALESCE(pg.output_count, 1)) AS plc_total
  INTO v_plc
  FROM public.equipments e
  LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
  WHERE e.farm_id = _farm_id
    AND e.active = true
    AND e.type IN ('poco', 'bombeamento', 'nivel')
    AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) IS NOT NULL
    AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) ~* '^[0-9a-f]{4}$'
    AND (v_force_tsnn IS NULL
         OR upper(COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4))) = upper(v_force_tsnn))
    AND NOT EXISTS (
      SELECT 1 FROM public.service_mode_locks sml
      WHERE sml.farm_id = _farm_id
        AND sml.tsnn = COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4))
        AND sml.expires_at > now()
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.commands c
      JOIN public.equipments ce ON ce.id = c.equipment_id
      LEFT JOIN public.plc_groups cpg ON cpg.id = ce.plc_group_id
      WHERE c.farm_id = _farm_id
        AND ce.farm_id = _farm_id
        AND c.type = 'manual'
        AND c.status IN ('pending', 'sent')
        AND COALESCE(c.source_device, '') NOT LIKE 'backend-reset:%'
        AND COALESCE(c.sent_at, c.created_at) > now() - interval '90 seconds'
        AND COALESCE(NULLIF(cpg.hw_id, ''), substring(ce.hw_id from 1 for 4)) = COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4))
    )
  GROUP BY 1
  ORDER BY oldest_polling_at ASC NULLS FIRST, tsnn ASC
  LIMIT 1;

  -- Se o PLC do retry nao esta elegivel agora, cai no rodizio normal
  IF v_plc.tsnn IS NULL AND v_force_tsnn IS NOT NULL THEN
    v_force_tsnn := NULL;
    v_retry := 0;

    SELECT
      COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) AS tsnn,
      MIN(e.last_polling_at) AS oldest_polling_at,
      MAX(COALESCE(pg.output_count, 1)) AS plc_total
    INTO v_plc
    FROM public.equipments e
    LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
    WHERE e.farm_id = _farm_id
      AND e.active = true
      AND e.type IN ('poco', 'bombeamento', 'nivel')
      AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) IS NOT NULL
      AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) ~* '^[0-9a-f]{4}$'
      AND NOT EXISTS (
        SELECT 1 FROM public.service_mode_locks sml
        WHERE sml.farm_id = _farm_id
          AND sml.tsnn = COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4))
          AND sml.expires_at > now()
      )
      AND NOT EXISTS (
        SELECT 1
        FROM public.commands c
        JOIN public.equipments ce ON ce.id = c.equipment_id
        LEFT JOIN public.plc_groups cpg ON cpg.id = ce.plc_group_id
        WHERE c.farm_id = _farm_id
          AND ce.farm_id = _farm_id
          AND c.type = 'manual'
          AND c.status IN ('pending', 'sent')
          AND COALESCE(c.source_device, '') NOT LIKE 'backend-reset:%'
          AND COALESCE(c.sent_at, c.created_at) > now() - interval '90 seconds'
          AND COALESCE(NULLIF(cpg.hw_id, ''), substring(ce.hw_id from 1 for 4)) = COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4))
      )
    GROUP BY 1
    ORDER BY oldest_polling_at ASC NULLS FIRST, tsnn ASC
    LIMIT 1;
  END IF;

  IF v_plc.tsnn IS NULL THEN
    RETURN 0;
  END IF;

  SELECT COALESCE(MAX(COALESCE(e.saida, 1)), 0)
  INTO v_max_saida
  FROM public.equipments e
  LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
  WHERE e.farm_id = _farm_id
    AND e.active = true
    AND e.type IN ('poco', 'bombeamento')
    AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) = v_plc.tsnn;

  v_plc_total := COALESCE(v_plc.plc_total, 1);
  IF v_plc_total < 1 THEN v_plc_total := 1; END IF;
  IF v_plc_total > 6 THEN v_plc_total := 6; END IF;

  v_payload := repeat('0', v_plc_total);

  FOR v_eq IN
    SELECT e.id, e.saida,
           COALESCE(e.desired_running, false) AS desired_running
    FROM public.equipments e
    LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
    WHERE e.farm_id = _farm_id
      AND e.active = true
      AND e.type IN ('poco', 'bombeamento')
      AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) = v_plc.tsnn
  LOOP
    v_pos := COALESCE(v_eq.saida, 1);
    IF v_pos < 1 OR v_pos > v_plc_total THEN CONTINUE; END IF;
    IF v_eq.desired_running THEN
      v_payload := overlay(v_payload placing '1' from v_pos for 1);
    END IF;
  END LOOP;

  IF v_plc_total = 1 THEN
    v_frame := '[' || v_plc.tsnn || '_1_]{' || substring(v_payload from 1 for 1) || '}[' || v_plc.tsnn || '_ETX_]' || E'\r';
  ELSE
    v_frame := '[' || v_plc.tsnn || '_1_]{' || v_payload || '}[' || v_plc.tsnn || '_ETX_]' || E'\r';
  END IF;

  SELECT e.id INTO v_first_eq_id
  FROM public.equipments e
  LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
  WHERE e.farm_id = _farm_id
    AND e.active = true
    AND e.type IN ('poco', 'bombeamento', 'nivel')
    AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) = v_plc.tsnn
  ORDER BY CASE WHEN e.type IN ('poco','bombeamento') THEN 0 ELSE 1 END,
           e.saida NULLS LAST,
           e.created_at ASC
  LIMIT 1;

  INSERT INTO public.commands(farm_id, equipment_id, plc_hw_id, type, status, frame,
                              priority, timeout_ms, source_device, retry_count)
  VALUES (_farm_id, v_first_eq_id, v_plc.tsnn, 'polling', 'pending', v_frame,
          5, 13000, 'platform-scheduler',
          CASE WHEN v_force_tsnn IS NOT NULL THEN v_retry + 1 ELSE 0 END);

  UPDATE public.equipments e
  SET last_polling_at = now()
  FROM public.plc_groups pg
  WHERE e.farm_id = _farm_id
    AND e.active = true
    AND e.plc_group_id = pg.id
    AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) = v_plc.tsnn;

  UPDATE public.equipments e
  SET last_polling_at = now()
  WHERE e.farm_id = _farm_id
    AND e.active = true
    AND e.plc_group_id IS NULL
    AND substring(e.hw_id from 1 for 4) = v_plc.tsnn;

  RETURN 1;
END;
$function$;