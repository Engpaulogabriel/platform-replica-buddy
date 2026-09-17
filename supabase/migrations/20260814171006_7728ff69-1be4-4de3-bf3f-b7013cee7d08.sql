ALTER TABLE public.remote_reconciliation_queue
  ADD COLUMN IF NOT EXISTS suggestion_strength text,
  ADD COLUMN IF NOT EXISTS suggestion_source text,
  ADD COLUMN IF NOT EXISTS suggestion_basis jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.enqueue_remote_reconciliation(_farm_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  r record; n int := 0; v_cand jsonb;
  v_strong jsonb; v_strength text; v_source text; v_basis jsonb; v_named_src text;
  v_suggested uuid;
BEGIN
  FOR r IN SELECT * FROM public.remote_authorship_decision(_farm_id) LOOP
    SELECT COALESCE(jsonb_agg(DISTINCT jsonb_build_object(
             'user_id', c.user_id, 'nome', c.nome, 'email', c.email,
             'fonte', c.fonte, 'forca', c.forca)), '[]'::jsonb)
      INTO v_cand
      FROM public.automation_log al
      CROSS JOIN LATERAL public.remote_event_authorship_candidates(al.id) c
     WHERE al.id = ANY(r.ids) AND al.user_id IS NULL;

    -- Candidato DIRETO (forte): trilha auditável ligada ao próprio evento.
    SELECT c INTO v_strong
      FROM jsonb_array_elements(v_cand) c
     WHERE c->>'user_id' IS NOT NULL
       AND c->>'fonte' IN ('command_audit','commands','details_json','whatsapp_operator','batch_reconciliation')
     LIMIT 1;

    -- Fonte original do nome já presente no lote (quando houver).
    SELECT COALESCE(string_agg(DISTINCT COALESCE(al.details->>'authorship_source','legado_sem_fonte'), ', '), 'legado_sem_fonte')
      INTO v_named_src
      FROM public.automation_log al
     WHERE al.id = ANY(r.ids) AND al.user_id IS NOT NULL;

    IF v_strong IS NOT NULL THEN
      v_suggested := (v_strong->>'user_id')::uuid;
      v_strength  := 'strong';
      v_source    := v_strong->>'fonte';
      v_basis     := jsonb_build_object('kind','direct_trail','fonte', v_strong->>'fonte');
    ELSIF r.candidatas = 1 AND r.candidata_user_id IS NOT NULL THEN
      v_suggested := r.candidata_user_id;
      -- Nome vem de OUTRO evento do mesmo lote: evidência indireta.
      v_strength  := CASE WHEN v_named_src ILIKE '%batch_reconciliation%'
                            OR v_named_src ILIKE '%command_audit%'
                          THEN 'strong' ELSE 'corroborated_batch' END;
      v_source    := 'nome_ja_presente_no_lote:' || v_named_src;
      v_basis     := jsonb_build_object('kind','in_batch_name','origem_do_nome', v_named_src);
    ELSE
      v_suggested := NULL; v_strength := NULL; v_source := NULL; v_basis := '{}'::jsonb;
    END IF;

    INSERT INTO public.remote_reconciliation_queue (
      farm_id, batch_id, started_at, ended_at, intent, event_ids,
      events_total, events_unnamed, suggested_user, candidates,
      suggestion_strength, suggestion_source, suggestion_basis)
    SELECT al.farm_id, r.batch_id, min(al.occurred_at), max(al.occurred_at), r.acao,
           r.ids, r.eventos, r.sem_nome, v_suggested, v_cand,
           v_strength, v_source, v_basis
      FROM public.automation_log al WHERE al.id = ANY(r.ids)
     GROUP BY al.farm_id
    ON CONFLICT (farm_id, batch_id) DO UPDATE SET
      event_ids = EXCLUDED.event_ids, events_unnamed = EXCLUDED.events_unnamed,
      suggested_user = EXCLUDED.suggested_user, candidates = EXCLUDED.candidates,
      suggestion_strength = EXCLUDED.suggestion_strength,
      suggestion_source = EXCLUDED.suggestion_source,
      suggestion_basis = EXCLUDED.suggestion_basis
      WHERE public.remote_reconciliation_queue.status = 'pending';
    n := n + 1;
  END LOOP;
  RETURN n;
END; $function$;

CREATE OR REPLACE FUNCTION public.apply_remote_reconciliation(
  _queue_id uuid, _user_id uuid, _expected_ids uuid[], _executor uuid,
  _evidence text DEFAULT NULL::text, _confirm_corroborated boolean DEFAULT false)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE q public.remote_reconciliation_queue%ROWTYPE; v_now uuid[]; n int; v_email text; v_nome text;
        v_caller uuid; v_service boolean; v_conf text;
BEGIN
  v_caller := auth.uid();
  v_service := COALESCE(auth.role(), '') = 'service_role'
               OR session_user IN ('postgres','supabase_admin','service_role');

  IF _executor IS NULL THEN RAISE EXCEPTION 'ABORTADO: executor obrigatório'; END IF;

  IF NOT v_service THEN
    IF v_caller IS NULL THEN
      RAISE EXCEPTION 'ABORTADO: chamada não autenticada';
    END IF;
    IF _executor <> v_caller THEN
      RAISE EXCEPTION 'ABORTADO: executor informado difere do usuário autenticado';
    END IF;
  END IF;

  SELECT * INTO q FROM public.remote_reconciliation_queue WHERE id = _queue_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ABORTADO: lote % inexistente', _queue_id; END IF;

  IF NOT v_service THEN
    IF NOT (
      public.is_platform_admin(v_caller)
      OR public.has_farm_role(v_caller, q.farm_id, 'owner'::public.app_role)
      OR public.has_farm_role(v_caller, q.farm_id, 'admin'::public.app_role)
    ) THEN
      RAISE EXCEPTION 'ABORTADO: sem autorização para reconciliar autoria nesta fazenda';
    END IF;
  END IF;

  IF q.status <> 'pending' THEN RAISE EXCEPTION 'ABORTADO: lote já % (anti-replay)', q.status; END IF;

  -- Confiança real: sugestão apenas corroborada exige confirmação humana explícita.
  v_conf := CASE WHEN _user_id IS NOT DISTINCT FROM q.suggested_user
                 THEN COALESCE(q.suggestion_strength, 'corroborated_batch')
                 ELSE 'admin_decision' END;

  IF v_conf = 'corroborated_batch' AND NOT _confirm_corroborated THEN
    RAISE EXCEPTION 'ABORTADO: sugestão apenas corroborada pelo lote (fonte: %). Confirmação explícita obrigatória.',
      COALESCE(q.suggestion_source, 'indeterminada');
  END IF;

  SELECT p.email, p.full_name INTO v_email, v_nome FROM public.profiles p WHERE p.id = _user_id;
  IF v_nome IS NULL AND v_email IS NULL THEN
    RAISE EXCEPTION 'ABORTADO: user_id % não existe em profiles', _user_id;
  END IF;

  SELECT array_agg(al.id ORDER BY al.id) INTO v_now
    FROM public.automation_log al
   WHERE al.id = ANY(q.event_ids) AND al.user_id IS NULL;

  IF COALESCE(array_length(v_now,1),0) <> COALESCE(array_length(_expected_ids,1),0)
     OR NOT (v_now @> _expected_ids AND _expected_ids @> v_now) THEN
    RAISE EXCEPTION 'ABORTADO: conjunto mudou desde a conferência (esperado %, atual %). Nada alterado.',
      COALESCE(array_length(_expected_ids,1),0), COALESCE(array_length(v_now,1),0);
  END IF;

  UPDATE public.automation_log al
     SET user_id = _user_id, user_email = v_email, actor_label = COALESCE(v_nome, v_email),
         details = COALESCE(al.details,'{}'::jsonb) || jsonb_build_object(
           'authorship_source','batch_reconciliation',
           'authorship_confidence', v_conf,
           'authorship_origin_source', COALESCE(q.suggestion_source, 'escolha_administrativa'),
           'authorship_evidence', COALESCE(_evidence, 'reconciliação de lote ' || q.batch_id),
           'authorship_batch_id', q.batch_id,
           'authorship_verified_at', now(),
           'authorship_verified_by', COALESCE(v_caller, _executor))
   WHERE al.id = ANY(_expected_ids)
     AND al.origin = 'remote'::public.event_origin;
  GET DIAGNOSTICS n = ROW_COUNT;

  UPDATE public.authorship_pending_review r
     SET resolved_at = now(), resolved_by = COALESCE(v_caller, _executor)
   WHERE r.automation_log_id = ANY(_expected_ids) AND r.resolved_at IS NULL;

  UPDATE public.remote_reconciliation_queue
     SET status='applied', applied_user=_user_id, applied_by=COALESCE(v_caller,_executor), applied_at=now()
   WHERE id = _queue_id;

  INSERT INTO public.authorship_reconciliation_batches (
    farm_id, batch_id, started_at, ended_at, intent, event_ids, events_total,
    applied_user, applied_email, applied_actor, applied_by, evidence, confidence)
  VALUES (q.farm_id, q.batch_id, q.started_at, q.ended_at, q.intent,
          _expected_ids, COALESCE(array_length(_expected_ids,1),0),
          _user_id, v_email, COALESCE(v_nome, v_email), COALESCE(v_caller,_executor),
          COALESCE(_evidence, 'reconciliação de lote ' || q.batch_id), v_conf);

  RETURN n;
END; $function$;

REVOKE EXECUTE ON FUNCTION public.apply_remote_reconciliation(uuid, uuid, uuid[], uuid, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.apply_remote_reconciliation(uuid, uuid, uuid[], uuid, text, boolean) TO authenticated;