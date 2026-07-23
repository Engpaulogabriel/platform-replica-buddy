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
  v_desired_on boolean;
  v_frame text;
  v_first_eq_id uuid;
BEGIN
  DELETE FROM public.commands
  WHERE farm_id = _farm_id
    AND status = 'pending'
    AND type = 'polling'
    AND created_at < now() - interval '30 seconds';

  UPDATE public.commands
  SET status = 'timeout',
      responded_at = now(),
      error_message = 'Sem resposta dentro do timeout'
  WHERE farm_id = _farm_id
    AND status = 'sent'
    AND type = 'polling'
    AND sent_at < now() - (GREATEST(timeout_ms, 13000) || ' milliseconds')::interval;

  IF EXISTS (
    SELECT 1 FROM public.commands c
    WHERE c.farm_id = _farm_id
      AND c.type = 'polling'
      AND c.source_device = 'platform-scheduler'
      AND c.created_at > now() - interval '12.5 seconds'
  ) THEN
    RETURN 0;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.commands c
    WHERE c.farm_id = _farm_id
      AND c.status IN ('pending', 'sent')
      AND c.type = 'polling'
  ) THEN
    RETURN 0;
  END IF;

  -- Inclui sensores 'nivel' no rodízio de polling. O firmware do PLC
  -- anexa sufixo _N1<raw>N1_ / _N2<raw>N2_ ao RX, atualizando reservatórios.
  SELECT
    COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) AS tsnn,
    MIN(e.last_polling_at) AS oldest_polling_at
  INTO v_plc
  FROM public.equipments e
  LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
  WHERE e.farm_id = _farm_id
    AND e.active = true
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

  IF v_plc.tsnn IS NULL THEN
    RETURN 0;
  END IF;

  -- Maior saída usada na PLC considera bombas E sensores de nível
  SELECT COALESCE(MAX(COALESCE(e.saida, 1)), 0)
  INTO v_max_saida
  FROM public.equipments e
  LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
  WHERE e.farm_id = _farm_id
    AND e.active = true
    AND e.type IN ('poco', 'bombeamento', 'nivel')
    AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) = v_plc.tsnn;

  IF v_max_saida < 1 THEN
    RETURN 0;
  END IF;
  IF v_max_saida > 6 THEN
    v_max_saida := 6;
  END IF;

  v_payload := '';
  v_first_eq_id := NULL;

  FOR v_pos IN 1..v_max_saida LOOP
    v_desired_on := false;

    -- Apenas BOMBAS controlam relé. Sensores de nível ocupam saída mas
    -- o payload nessa posição deve ser sempre '0' (não acionar nada).
    SELECT
      e.id,
      COALESCE(e.desired_running, false) AS desired_running
    INTO v_eq
    FROM public.equipments e
    LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
    WHERE e.farm_id = _farm_id
      AND e.active = true
      AND e.type IN ('poco', 'bombeamento')
      AND COALESCE(e.saida, 1) = v_pos
      AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) = v_plc.tsnn
    LIMIT 1;

    IF FOUND THEN
      v_desired_on := v_eq.desired_running;
      v_payload := v_payload || (CASE WHEN v_desired_on THEN '1' ELSE '0' END);
      IF v_first_eq_id IS NULL THEN
        v_first_eq_id := v_eq.id;
      END IF;
    ELSE
      v_payload := v_payload || '0';
    END IF;
  END LOOP;

  -- Se não há bomba na PLC, equipment_id pode referenciar um nivel
  IF v_first_eq_id IS NULL THEN
    SELECT e.id INTO v_first_eq_id
    FROM public.equipments e
    LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
    WHERE e.farm_id = _farm_id
      AND e.active = true
      AND e.type = 'nivel'
      AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) = v_plc.tsnn
    ORDER BY COALESCE(e.saida, 1) ASC
    LIMIT 1;
  END IF;

  v_frame := '[' || v_plc.tsnn || '_1_]{' || v_payload || '}[' || v_plc.tsnn || '_ETX_]' || E'\r';

  INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device)
  VALUES (_farm_id, v_first_eq_id, v_plc.tsnn, 'polling', 5, v_frame, 13000, 'platform-scheduler');

  -- Atualiza last_polling_at de TODOS os equipamentos da PLC (bombas + niveis)
  UPDATE public.equipments e
  SET last_polling_at = now()
  WHERE e.farm_id = _farm_id
    AND e.active = true
    AND e.type IN ('poco', 'bombeamento', 'nivel')
    AND COALESCE(
          (SELECT pg.hw_id FROM public.plc_groups pg WHERE pg.id = e.plc_group_id),
          substring(e.hw_id from 1 for 4)
        ) = v_plc.tsnn;

  RETURN 1;
END;
$function$;