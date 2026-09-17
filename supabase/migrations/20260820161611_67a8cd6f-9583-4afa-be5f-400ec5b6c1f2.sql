-- ============================================================================
-- WRITER FÍSICO CANÔNICO — classifica ANTES de gravar.
-- ----------------------------------------------------------------------------
-- CAUSA DO INCIDENTE: `log_equipment_state_change` gravava a confirmação da PLC
-- SEM user_id/user_email/actor_label. O guarda da Fase B, rodando no mesmo
-- INSERT, via `origin='remote'` com autoria vazia e marcava
-- `noise_reason='pending_authorship_review'`. Resultado: toda atuação remota e
-- local sumia do relatório; só a automação das 17h passava, porque o trigger
-- do desligamento programado preenche actor_label com o nome da regra.
--
-- Correção: a classificação passa a acontecer ANTES da gravação, na ordem
-- 1) transição física · 2) automação · 3) command_audit/commands · 4) local.
--
-- NÃO altera agente, rádio, bridge, polling, Realtime, dashboard, mini
-- relatório, proteção de comutação, cron, WhatsApp, FASE 2/3, OTA nem a lógica
-- de controle de bombas.
-- ============================================================================

-- ── 1) Classificador: dado um equipamento e uma transição, quem causou? ─────
CREATE OR REPLACE FUNCTION public.classify_physical_transition(
  _equipment_id uuid, _farm_id uuid, _turning_on boolean,
  _at timestamptz DEFAULT now(), _window interval DEFAULT interval '3 minutes')
RETURNS TABLE (origin public.event_origin, actor_label text, user_id uuid,
               user_email text, command_id uuid, authorship_source text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_intent text; r record; v_rule text;
BEGIN
  v_intent := CASE WHEN _turning_on THEN 'turn_on' ELSE 'turn_off' END;

  -- ── (2) AUTOMAÇÃO COMPATÍVEL ────────────────────────────────────────────
  -- Comando gerado pela automação (prova durável por equipamento).
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

  -- Fallback por janela da regra (mesma lógica do Relatório).
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

  -- ── (3) COMANDO COM AUTORIA REAL — antes de qualquer local/ruído ────────
  SELECT ca.user_id, ca.user_email, ca.actor_label, ca.command_id, ca.origin_kind
    INTO r
    FROM public.command_audit ca
   WHERE ca.equipment_id = _equipment_id
     AND ca.user_id IS NOT NULL
     AND ca.intent = v_intent
     AND ca.command_created_at BETWEEN _at - _window AND _at + _window
   ORDER BY abs(extract(epoch FROM (ca.command_created_at - _at)))
   LIMIT 1;
  IF FOUND AND r.user_id IS NOT NULL THEN
    RETURN QUERY SELECT
      CASE WHEN r.origin_kind = 'whatsapp' THEN 'whatsapp'::text
           ELSE 'remote' END::public.event_origin,
      COALESCE(NULLIF(btrim(r.actor_label),''),
               (SELECT p.full_name FROM public.profiles p WHERE p.id = r.user_id),
               r.user_email),
      r.user_id, r.user_email, r.command_id, 'command_audit';
    RETURN;
  END IF;

  -- `commands` ainda vivo (autoria em created_by)
  SELECT c.created_by AS uid, p.email, p.full_name, c.id AS cid
    INTO r
    FROM public.commands c LEFT JOIN public.profiles p ON p.id = c.created_by
   WHERE c.equipment_id = _equipment_id AND c.created_by IS NOT NULL
     AND c.type = 'manual'::public.command_type
     AND c.created_at BETWEEN _at - _window AND _at + _window
   ORDER BY abs(extract(epoch FROM (c.created_at - _at))) LIMIT 1;
  IF FOUND AND r.uid IS NOT NULL THEN
    RETURN QUERY SELECT 'remote'::public.event_origin,
      COALESCE(r.full_name, r.email), r.uid, r.email, r.cid, 'commands';
    RETURN;
  END IF;

  -- ── (4) TRANSIÇÃO FÍSICA SEM COMANDO NEM AUTOMAÇÃO = LOCAL DE VERDADE ───
  RETURN QUERY SELECT 'local'::public.event_origin, 'Acionamento local',
    NULL::uuid, NULL::text, NULL::uuid, 'spontaneous_tx';
END; $$;
GRANT EXECUTE ON FUNCTION public.classify_physical_transition(uuid,uuid,boolean,timestamptz,interval)
  TO authenticated, service_role;

-- ── 2) O writer físico, agora classificando antes de gravar ────────────────
CREATE OR REPLACE FUNCTION public.log_equipment_state_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
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
END; $$;

-- ── 3) O guarda para de esconder transição física real ─────────────────────
-- Ele continua barrando polling, eco, retry, boot, startup, status_read,
-- reading, falha/timeout e origem indefinida. O que ele NÃO pode mais fazer é
-- marcar como ruído uma transição confirmada só porque a autoria está vazia.
CREATE OR REPLACE FUNCTION public.guard_official_report_row()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.noise_reason IS NOT NULL THEN RETURN NEW; END IF;

  -- técnico: nunca é evento oficial
  IF NEW.action NOT IN ('turn_on','turn_off','pump_on','pump_off') THEN
    NEW.noise_reason := 'technical_not_a_transition'; RETURN NEW;
  END IF;
  IF NEW.origin = 'reading'::public.event_origin THEN
    NEW.noise_reason := 'technical_not_a_transition'; RETURN NEW;
  END IF;
  IF NEW.equipment_id IS NULL THEN
    NEW.noise_reason := 'no_equipment'; RETURN NEW;
  END IF;

  -- sem confirmação física não é transição
  IF NEW.result IS DISTINCT FROM 'success'::public.event_result
     AND COALESCE(NEW.details->>'state_confirmed','') <> 'true' THEN
    NEW.noise_reason := 'command_not_confirmed'; RETURN NEW;
  END IF;

  -- origem indefinida: normaliza para Local em vez de esconder.
  -- Transição física real NUNCA vira ruído por falta de autoria.
  IF NEW.origin = 'system'::public.event_origin THEN
    NEW.origin := 'local'::public.event_origin;
    NEW.actor_label := 'Acionamento local';
    NEW.details := COALESCE(NEW.details,'{}'::jsonb)
                   || jsonb_build_object('normalized_from','system');
    RETURN NEW;
  END IF;

  -- rótulo técnico no lugar da pessoa: limpa o RÓTULO, mantém a linha.
  IF public.is_technical_actor_label(NEW.actor_label) THEN
    IF NEW.origin = 'local'::public.event_origin THEN
      NEW.actor_label := 'Acionamento local';
    ELSE
      NEW.actor_label := NULL;   -- fica vazio; a recuperação preenche depois
    END IF;
    NEW.details := COALESCE(NEW.details,'{}'::jsonb)
                   || jsonb_build_object('technical_label_stripped', true);
  END IF;

  -- Local sem rótulo ganha o rótulo canônico
  IF NEW.origin = 'local'::public.event_origin
     AND COALESCE(btrim(NEW.actor_label),'') = '' THEN
    NEW.actor_label := 'Acionamento local';
  END IF;

  RETURN NEW;
END; $$;

-- ============================================================================
-- CONFERÊNCIA
--   SELECT origin::text, count(*) FILTER (WHERE noise_reason IS NULL) AS oficial,
--          count(*) FILTER (WHERE noise_reason IS NOT NULL) AS excluido
--     FROM public.automation_log
--    WHERE occurred_at > now() - interval '48 hours'
--      AND action IN ('turn_on','turn_off','pump_on','pump_off')
--    GROUP BY 1;
-- ROLLBACK: reaplicar 20260724050000 (writer antigo) e 20260814221200 (guarda).
-- ============================================================================