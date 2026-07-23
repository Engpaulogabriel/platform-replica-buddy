-- ============================================================
-- 1) Limpa duplicatas e níveis fantasma (sem PLC vinculado)
-- ============================================================
-- Remove: Cisterna, Reservatório Elevado, Reservatório Principal (x2),
-- Reservatório Secundário (x2). Mantém apenas Canal Santa Maria e
-- Canal Santo Antônio (ambos com plc_group_id).
DELETE FROM public.equipments
WHERE type = 'nivel' AND plc_group_id IS NULL;

-- ============================================================
-- 2) Migra calibração de 2 pontos para 1 ponto
-- ============================================================
-- Adiciona novas colunas
ALTER TABLE public.equipments
  ADD COLUMN IF NOT EXISTS level_cal_digital integer,
  ADD COLUMN IF NOT EXISTS level_cal_meters numeric(8,3),
  ADD COLUMN IF NOT EXISTS level_max_meters numeric(8,3);

-- Migra dados antigos: usa o ponto MAX se existir, senão MIN.
-- max_height existente vira level_max_meters (representa 100%).
UPDATE public.equipments
SET
  level_cal_digital = COALESCE(level_cal_raw_max, level_cal_raw_min),
  level_cal_meters  = COALESCE(level_cal_meters_max, level_cal_meters_min),
  level_max_meters  = COALESCE(level_max_meters, max_height)
WHERE type = 'nivel'
  AND (level_cal_raw_min IS NOT NULL OR level_cal_raw_max IS NOT NULL OR max_height IS NOT NULL);

-- Garante level_sensor_index = 1 nos níveis vinculados que ainda não têm
UPDATE public.equipments
SET level_sensor_index = 1
WHERE type = 'nivel'
  AND plc_group_id IS NOT NULL
  AND level_sensor_index IS NULL;

-- Remove colunas antigas de calibração 2 pontos
ALTER TABLE public.equipments
  DROP COLUMN IF EXISTS level_cal_raw_min,
  DROP COLUMN IF EXISTS level_cal_meters_min,
  DROP COLUMN IF EXISTS level_cal_raw_max,
  DROP COLUMN IF EXISTS level_cal_meters_max;

-- ============================================================
-- 3) Atualiza polling para incluir 'nivel'
-- ============================================================
-- Para tipo 'nivel', o frame de polling é só uma consulta de status:
-- payload zerado na saída cadastrada do equipamento. A resposta RX
-- vai trazer o sufixo _N1xxxN1_ (e/ou _N2xxxN2_) que o agente Electron
-- já parseia via apply_level_telemetry.

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
  v_intent_bit text;
  v_last_payload text;
  v_desired_on boolean;
  v_frame text;
  v_first_eq_id uuid;
BEGIN
  -- Limpa pendings velhos e marca timeouts
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

  -- Anti-burst
  IF EXISTS (
    SELECT 1 FROM public.commands c
    WHERE c.farm_id = _farm_id
      AND c.type = 'polling'
      AND c.source_device = 'platform-scheduler'
      AND c.created_at > now() - interval '12.5 seconds'
  ) THEN
    RETURN 0;
  END IF;

  -- Polling em curso?
  IF EXISTS (
    SELECT 1 FROM public.commands c
    WHERE c.farm_id = _farm_id
      AND c.status IN ('pending', 'sent')
      AND c.type = 'polling'
  ) THEN
    RETURN 0;
  END IF;

  -- PLC mais antigo no rodízio (inclui PLCs que só têm sensores de nível)
  SELECT
    COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) AS tsnn,
    MIN(COALESCE(e.last_polling_at, 'epoch'::timestamptz)) AS oldest_polling_at
  INTO v_plc
  FROM public.equipments e
  LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
  WHERE e.farm_id = _farm_id
    AND e.active = true
    AND e.type IN ('poco', 'bombeamento', 'nivel')
    AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) IS NOT NULL
    AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) ~ '^\d{4}$'
  GROUP BY 1
  ORDER BY oldest_polling_at ASC, tsnn ASC
  LIMIT 1;

  IF v_plc.tsnn IS NULL THEN
    RETURN 0;
  END IF;

  -- Tamanho do payload = maior número de saída cadastrada para esse PLC (1..6),
  -- considerando bombas E sensores de nível (eles podem compartilhar PLC).
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
    v_intent_bit := NULL;
    v_desired_on := false;

    -- Procura bomba (poco/bombeamento) nessa saída
    SELECT e.id, COALESCE(e.desired_running, false) AS desired_running, e.type
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
      SELECT substring(c.frame from '\{([01]{1,6})\}')
      INTO v_last_payload
      FROM public.commands c
      WHERE c.farm_id = _farm_id
        AND c.equipment_id = v_eq.id
        AND c.type = 'manual'
        AND substring(c.frame from '\{([01]{1,6})\}') IS NOT NULL
      ORDER BY COALESCE(c.sent_at, c.created_at) DESC
      LIMIT 1;

      IF v_last_payload IS NOT NULL THEN
        IF length(v_last_payload) >= v_pos THEN
          v_intent_bit := substring(v_last_payload from v_pos for 1);
        ELSE
          v_intent_bit := right(v_last_payload, 1);
        END IF;
      END IF;

      IF v_intent_bit IN ('0', '1') THEN
        v_desired_on := v_intent_bit = '1';
      ELSE
        v_desired_on := v_eq.desired_running;
      END IF;

      v_payload := v_payload || (CASE WHEN v_desired_on THEN '1' ELSE '0' END);

      IF v_first_eq_id IS NULL THEN
        v_first_eq_id := v_eq.id;
      END IF;
    ELSE
      -- Sem bomba nessa posição: '0' (zero seguro). Mesmo que haja sensor de
      -- nível com essa saída, ele não controla relé — é só leitura.
      v_payload := v_payload || '0';

      -- Se for um equipamento de nível ocupando essa saída, usamos seu id como
      -- equipment_id de referência (caso não haja bomba primeira no PLC).
      IF v_first_eq_id IS NULL THEN
        SELECT e.id INTO v_first_eq_id
        FROM public.equipments e
        LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
        WHERE e.farm_id = _farm_id
          AND e.active = true
          AND e.type = 'nivel'
          AND COALESCE(e.saida, 1) = v_pos
          AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) = v_plc.tsnn
        LIMIT 1;
      END IF;
    END IF;
  END LOOP;

  v_frame := '[' || v_plc.tsnn || '_1_]{' || v_payload || '}[' || v_plc.tsnn || '_ETX_]' || E'\r';

  INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device)
  VALUES (_farm_id, v_first_eq_id, v_plc.tsnn, 'polling', 5, v_frame, 13000, 'platform-scheduler');

  -- Marca polling em TODOS os equipamentos do PLC (bombas e níveis) para o rodízio
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