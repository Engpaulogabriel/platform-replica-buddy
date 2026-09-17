-- ============================================================================
-- LIMPEZA DOS ALERTAS FALSOS DE "Possível falta de energia".
-- ============================================================================

-- ── Backup: nada some sem cópia ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.farm_notifications_purged (
  id           uuid PRIMARY KEY,
  farm_id      uuid NOT NULL,
  kind         text,
  severity     text,
  title        text,
  message      text,
  source       text,
  source_ref   uuid,
  equipment_id uuid,
  resolved_at  timestamptz,
  created_at   timestamptz,
  purged_at    timestamptz NOT NULL DEFAULT now(),
  purge_reason text NOT NULL,
  evidencia    jsonb NOT NULL DEFAULT '{}'::jsonb
);
GRANT ALL ON public.farm_notifications_purged TO service_role;
ALTER TABLE public.farm_notifications_purged ENABLE ROW LEVEL SECURITY;
-- sem policy: só service_role/superuser lê.

-- ── Diagnóstico. SOMENTE LEITURA. ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.false_power_alerts(_hours int DEFAULT 168)
RETURNS TABLE (id uuid, farm_id uuid, fazenda text, created_at timestamptz,
               bombas_na_janela bigint, tem_prova boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH alerta AS (
    SELECT n.id, n.farm_id, f.name AS fazenda, n.created_at
      FROM public.farm_notifications n
      JOIN public.farms f ON f.id = n.farm_id
     WHERE n.source = 'falta_energia'
       AND n.created_at > now() - make_interval(hours => _hours)
  ),
  pico AS (
    SELECT a.id, COALESCE(MAX(w.bombas), 0) AS bombas
      FROM alerta a
      LEFT JOIN LATERAL (
        SELECT count(DISTINCT l2.equipment_id) AS bombas
          FROM public.automation_log l1
          JOIN public.automation_log l2
            ON l2.farm_id = l1.farm_id
           AND l2.occurred_at >= l1.occurred_at
           AND l2.occurred_at <  l1.occurred_at + interval '60 seconds'
           AND l2.action IN ('turn_off'::public.event_action,
                             'pump_off'::public.event_action)
           AND l2.origin IN ('reading'::public.event_origin,
                             'system'::public.event_origin)
           AND l2.result = 'success'::public.event_result
         WHERE l1.farm_id = a.farm_id
           AND l1.action IN ('turn_off'::public.event_action,
                             'pump_off'::public.event_action)
           AND l1.origin IN ('reading'::public.event_origin,
                             'system'::public.event_origin)
           AND l1.result = 'success'::public.event_result
           AND l1.occurred_at BETWEEN a.created_at - interval '10 minutes'
                                  AND a.created_at + interval '10 minutes'
         GROUP BY l1.id
      ) w ON true
     GROUP BY a.id
  )
  SELECT a.id, a.farm_id, a.fazenda, a.created_at, p.bombas, p.bombas >= 4
    FROM alerta a JOIN pico p ON p.id = a.id
   ORDER BY a.created_at DESC;
$$;
GRANT EXECUTE ON FUNCTION public.false_power_alerts(int) TO authenticated, service_role;

-- ── Resumo de uma linha ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.false_power_alerts_summary(_hours int DEFAULT 168)
RETURNS TABLE (total bigint, com_prova bigint, sem_prova bigint,
               outros_alertas_intocados bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT count(*),
         count(*) FILTER (WHERE tem_prova),
         count(*) FILTER (WHERE NOT tem_prova),
         (SELECT count(*) FROM public.farm_notifications
           WHERE source IS DISTINCT FROM 'falta_energia')
    FROM public.false_power_alerts(_hours);
$$;
GRANT EXECUTE ON FUNCTION public.false_power_alerts_summary(int) TO authenticated, service_role;

-- ── A limpeza ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.purge_false_power_alerts(_hours int DEFAULT 168)
RETURNS TABLE (removidos bigint, preservados bigint, outros_intocados bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_outros_antes bigint;
  v_outros_depois bigint;
  v_removidos bigint;
  v_preservados bigint;
BEGIN
  SELECT count(*) INTO v_outros_antes
    FROM public.farm_notifications WHERE source IS DISTINCT FROM 'falta_energia';

  INSERT INTO public.farm_notifications_purged
    (id, farm_id, kind, severity, title, message, source, source_ref,
     equipment_id, resolved_at, created_at, purge_reason, evidencia)
  SELECT n.id, n.farm_id, n.kind, n.severity, n.title, n.message, n.source,
         n.source_ref, n.equipment_id, n.resolved_at, n.created_at,
         'regra_antiga_sem_transicao_fisica',
         jsonb_build_object('bombas_distintas_em_60s', d.bombas_na_janela,
                            'minimo_exigido', 4,
                            'avaliado_em', now())
    FROM public.false_power_alerts(_hours) d
    JOIN public.farm_notifications n ON n.id = d.id
   WHERE NOT d.tem_prova
  ON CONFLICT (id) DO NOTHING;

  WITH alvo AS (
    SELECT id FROM public.false_power_alerts(_hours) WHERE NOT tem_prova
  )
  DELETE FROM public.farm_notifications n
   USING alvo a
   WHERE n.id = a.id
     AND n.source = 'falta_energia';
  GET DIAGNOSTICS v_removidos = ROW_COUNT;

  SELECT count(*) INTO v_preservados
    FROM public.false_power_alerts(_hours) WHERE tem_prova;

  SELECT count(*) INTO v_outros_depois
    FROM public.farm_notifications WHERE source IS DISTINCT FROM 'falta_energia';

  IF v_outros_antes <> v_outros_depois THEN
    RAISE EXCEPTION 'TRAVA: alertas de outras categorias mudaram de % para % — revertendo',
      v_outros_antes, v_outros_depois;
  END IF;

  RETURN QUERY SELECT v_removidos, v_preservados, v_outros_depois;
END; $$;
GRANT EXECUTE ON FUNCTION public.purge_false_power_alerts(int) TO service_role;

-- ── Rollback ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.restore_purged_power_alerts()
RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n bigint;
BEGIN
  INSERT INTO public.farm_notifications
    (id, farm_id, kind, severity, title, message, source, source_ref,
     equipment_id, resolved_at, created_at)
  SELECT id, farm_id, kind, severity, title, message, source, source_ref,
         equipment_id, resolved_at, created_at
    FROM public.farm_notifications_purged
   WHERE purge_reason = 'regra_antiga_sem_transicao_fisica'
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END; $$;
GRANT EXECUTE ON FUNCTION public.restore_purged_power_alerts() TO service_role;

-- ── Painel técnico do incidente ────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.comm_incident_detail(_notification_id uuid)
RETURNS TABLE (camada text, quando timestamptz, detalhe text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH n AS (SELECT * FROM public.farm_notifications WHERE id = _notification_id)
  SELECT 'agente', sh.last_heartbeat,
         sh.agent_status || ' | bridge=' || COALESCE(sh.com_connected::text,'?') ||
         ' | ' || COALESCE(sh.last_error, 'sem erro')
    FROM public.site_health sh, n WHERE sh.farm_id = n.farm_id
  UNION ALL
  SELECT 'transição física', l.occurred_at,
         l.equipment_name || ' | ' || l.action::text || ' | ' || l.origin::text
    FROM public.automation_log l, n
   WHERE l.farm_id = n.farm_id
     AND l.action IN ('turn_on'::public.event_action, 'turn_off'::public.event_action,
                      'pump_on'::public.event_action, 'pump_off'::public.event_action)
     AND l.occurred_at BETWEEN n.created_at - interval '10 min' AND n.created_at + interval '10 min'
  UNION ALL
  SELECT 'comando', c.created_at,
         c.type::text || ' | ' || COALESCE(c.source_device,'-') || ' | ' || c.status::text
    FROM public.commands c, n
   WHERE c.farm_id = n.farm_id
     AND c.created_at BETWEEN n.created_at - interval '10 min' AND n.created_at + interval '10 min'
   ORDER BY 2;
$$;
GRANT EXECUTE ON FUNCTION public.comm_incident_detail(uuid) TO authenticated, service_role;