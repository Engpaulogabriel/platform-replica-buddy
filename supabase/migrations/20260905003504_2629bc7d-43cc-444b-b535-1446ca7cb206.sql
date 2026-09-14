-- Rótulo do Modo Automático: "Automático HH:MM" conforme o horário cadastrado na programação
CREATE OR REPLACE FUNCTION public.automatic_mode_actor_label(_command_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  SELECT COALESCE(
    (SELECT 'Automático ' || l.scheduled_time
       FROM public.automation_execution_log l
      WHERE l.details->>'command_id' = _command_id::text
        AND l.scheduled_time IS NOT NULL
      ORDER BY l.executed_at DESC LIMIT 1),
    'Modo Automático');
$$;
GRANT EXECUTE ON FUNCTION public.automatic_mode_actor_label(uuid) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.classify_physical_transition(_equipment_id uuid, _farm_id uuid, _turning_on boolean, _at timestamp with time zone DEFAULT now(), _window interval DEFAULT '00:03:00'::interval)
 RETURNS TABLE(origin event_origin, actor_label text, user_id uuid, user_email text, command_id uuid, authorship_source text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- ── (2b) MODO AUTOMÁTICO (motor de automação em nuvem) ──────────────────
  -- Comandos ON gerados pelo motor (source_device='cloud-automation', sem usuário).
  IF _turning_on THEN
    SELECT c.id INTO r
      FROM public.commands c
     WHERE c.equipment_id = _equipment_id
       AND c.source_device = 'cloud-automation'
       AND c.created_at BETWEEN _at - interval '10 minutes' AND _at + interval '2 minutes'
     ORDER BY abs(extract(epoch FROM (c.created_at - _at)))
     LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT 'auto'::public.event_origin, public.automatic_mode_actor_label(r.id),
        NULL::uuid, NULL::text, r.id, 'cloud_automation';
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
END; $function$;

CREATE OR REPLACE FUNCTION public.resolve_event_authorship(_log_id uuid)
 RETURNS TABLE(origin_final text, user_id uuid, user_email text, actor_label text, evidence_source text, confidence text, evidence jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE al public.automation_log%ROWTYPE; v_intent text; r record;
BEGIN
  SELECT * INTO al FROM public.automation_log WHERE id = _log_id;
  IF NOT FOUND THEN RETURN; END IF;
  v_intent := CASE WHEN al.action IN ('turn_on','pump_on') THEN 'turn_on' ELSE 'turn_off' END;

  SELECT ca.user_id, ca.user_email, ca.actor_label, ca.command_id
    INTO r
    FROM public.command_audit ca
   WHERE ca.equipment_id = al.equipment_id
     AND ca.user_id IS NOT NULL
     AND ca.intent = v_intent
     AND ca.command_created_at BETWEEN al.occurred_at - interval '180 seconds'
                                   AND al.occurred_at + interval '180 seconds'
   ORDER BY abs(extract(epoch FROM (ca.command_created_at - al.occurred_at)))
   LIMIT 1;
  IF FOUND AND r.user_id IS NOT NULL THEN
    RETURN QUERY SELECT 'remote', r.user_id, r.user_email,
      COALESCE(NULLIF(btrim(r.actor_label),''),
               (SELECT p.full_name FROM public.profiles p WHERE p.id = r.user_id)),
      'command_audit', 'strong',
      jsonb_build_object('command_id', r.command_id, 'intent', v_intent);
    RETURN;
  END IF;

  SELECT c.created_by AS user_id, p.email, p.full_name, c.id AS command_id
    INTO r
    FROM public.commands c
    LEFT JOIN public.profiles p ON p.id = c.created_by
   WHERE c.equipment_id = al.equipment_id AND c.created_by IS NOT NULL
     AND c.created_at BETWEEN al.occurred_at - interval '180 seconds'
                          AND al.occurred_at + interval '180 seconds'
   ORDER BY abs(extract(epoch FROM (c.created_at - al.occurred_at))) LIMIT 1;
  IF FOUND AND r.user_id IS NOT NULL THEN
    RETURN QUERY SELECT 'remote', r.user_id, r.email, r.full_name,
      'commands', 'strong', jsonb_build_object('command_id', r.command_id);
    RETURN;
  END IF;

  -- Modo Automático: comando do motor de automação em nuvem (sem usuário).
  IF v_intent = 'turn_on' THEN
    SELECT c.id INTO r
      FROM public.commands c
     WHERE c.equipment_id = al.equipment_id
       AND c.source_device = 'cloud-automation'
       AND c.created_at BETWEEN al.occurred_at - interval '10 minutes'
                            AND al.occurred_at + interval '2 minutes'
     ORDER BY abs(extract(epoch FROM (c.created_at - al.occurred_at))) LIMIT 1;
    IF FOUND THEN
      RETURN QUERY SELECT 'auto', NULL::uuid, NULL::text, public.automatic_mode_actor_label(r.id),
        'cloud_automation', 'strong', jsonb_build_object('command_id', r.id);
      RETURN;
    END IF;
  END IF;

  IF public.parse_user_uuid(al.details->>'user_id') IS NOT NULL
     OR public.parse_user_uuid(al.details->>'requested_by') IS NOT NULL
     OR public.parse_user_uuid(al.details->>'created_by') IS NOT NULL THEN
    SELECT p.id, p.email, p.full_name INTO r
      FROM public.profiles p
     WHERE p.id = COALESCE(public.parse_user_uuid(al.details->>'user_id'),
                           public.parse_user_uuid(al.details->>'requested_by'),
                           public.parse_user_uuid(al.details->>'created_by'));
    IF FOUND THEN
      RETURN QUERY SELECT 'remote', r.id, r.email, r.full_name,
        'details_structured', 'strong', jsonb_build_object('from','details');
      RETURN;
    END IF;
  END IF;

  IF al.details->>'rule_name' IS NOT NULL OR al.details->>'schedule_id' IS NOT NULL THEN
    RETURN QUERY SELECT 'auto', NULL::uuid, NULL::text,
      COALESCE(al.details->>'rule_name',
               (SELECT s.name FROM public.scheduled_automations s
                 WHERE s.id::text = al.details->>'schedule_id')),
      'automation_rule', 'strong',
      jsonb_build_object('schedule_id', al.details->>'schedule_id');
    RETURN;
  END IF;

  IF al.origin = 'local'::public.event_origin AND NOT EXISTS (
        SELECT 1 FROM public.command_audit ca
         WHERE ca.equipment_id = al.equipment_id
           AND ca.command_created_at BETWEEN al.occurred_at - interval '180 seconds'
                                         AND al.occurred_at + interval '180 seconds')
     AND NOT EXISTS (
        SELECT 1 FROM public.commands c
         WHERE c.equipment_id = al.equipment_id
           AND c.created_at BETWEEN al.occurred_at - interval '180 seconds'
                                AND al.occurred_at + interval '180 seconds')
     AND (al.result = 'success'::public.event_result
          OR al.details->>'state_confirmed' = 'true') THEN
    RETURN QUERY SELECT 'local', NULL::uuid, NULL::text, 'Acionamento local'::text,
      'spontaneous_tx', 'strong',
      jsonb_build_object('rule','transição física confirmada sem comando compatível na janela');
    RETURN;
  END IF;

  RETURN QUERY SELECT NULL::text, NULL::uuid, NULL::text, NULL::text,
    'none', 'none', jsonb_build_object('rule','nenhuma evidência suficiente');
END; $function$;