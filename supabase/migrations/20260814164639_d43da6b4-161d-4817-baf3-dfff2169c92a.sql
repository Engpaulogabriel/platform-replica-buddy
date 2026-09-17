CREATE OR REPLACE FUNCTION public.apply_remote_reconciliation(_queue_id uuid, _user_id uuid, _expected_ids uuid[], _executor uuid, _evidence text DEFAULT NULL::text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE q public.remote_reconciliation_queue%ROWTYPE; v_now uuid[]; n int; v_email text; v_nome text; v_caller uuid; v_service boolean;
BEGIN
  v_caller := auth.uid();
  v_service := current_user IN ('service_role','postgres','supabase_admin');

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
           'authorship_confidence','strong',
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
          COALESCE(_evidence, 'reconciliação de lote ' || q.batch_id), 'strong');

  RETURN n;
END; $function$;