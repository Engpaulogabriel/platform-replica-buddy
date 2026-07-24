-- v3.25.27 — Keep-alive polling durante QUALQUER comando ativo (supera 20260724030000).
--
-- PROBLEMA: enqueue_polling_for_due_equipments_internal excluía uma PLC do polling
-- por 90s sempre que ela tinha um comando manual pending/sent na mesma PLC. Isso
-- deixava a PLC INTEIRA cega (sem keep-alive nem detecção) enquanto o comando não
-- resolvia — até ~120s no caso de um OFF que não confirma (bomba ligada na botoeira).
--
-- CONTEXTO: a partir do agente v3.25.27 o payload do polling é normalizado por SAÍDA
-- (normalizePollingFrame): LOCAL → {0} (relé passivo), REMOTO ligada → {1} (mantém o
-- relé), REMOTO desligada → {0}. Ou seja, o polling SEMPRE espelha a intenção atual
-- (origin/desired), nunca contraria um comando em andamento. Logo, é seguro polar uma
-- PLC mesmo com comando ativo — o polling reforça o mesmo estado que o comando busca.
--
-- FIX: remove por completo a exclusão de polling por comando manual ativo. A serial
-- é serializada (um polling em voo por vez, já garantido acima) e o agente ainda
-- suspende o polling da PLC durante o reforço via getActiveReinforcementForTsnn.
-- Nenhuma outra lógica muda.

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
BEGIN
  IF public.is_farm_in_maintenance(_farm_id) THEN
    RETURN 0;
  END IF;

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
      AND c.status IN ('pending', 'sent')
      AND c.type = 'polling'
  ) THEN
    RETURN 0;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.commands c
    WHERE c.farm_id = _farm_id
      AND c.type = 'polling'
      AND c.source_device = 'platform-scheduler'
      AND c.created_at > now() - interval '10 seconds'
  ) THEN
    RETURN 0;
  END IF;

  -- v3.25.27: exclusão de polling por comando manual ativo REMOVIDA. O polling é
  -- normalizado por saída no agente (LOCAL→0, REMOTO liga→1, REMOTO desliga→0) e
  -- nunca contraria o comando em andamento; a PLC não fica mais cega durante um OFF.
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
  GROUP BY 1
  ORDER BY oldest_polling_at ASC NULLS FIRST, tsnn ASC
  LIMIT 1;

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

  -- O frame espelha o desired_running. O agente v3.25.27 renormaliza por saída
  -- (LOCAL→0) antes do TX, mas o desired aqui é o ponto de partida correto.
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
                              priority, timeout_ms, source_device)
  VALUES (_farm_id, v_first_eq_id, v_plc.tsnn, 'polling', 'pending', v_frame,
          5, 13000, 'platform-scheduler');

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
