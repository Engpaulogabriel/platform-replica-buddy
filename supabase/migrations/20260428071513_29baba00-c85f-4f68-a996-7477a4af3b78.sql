CREATE OR REPLACE FUNCTION public.farm_backup_create(_farm_id uuid, _trigger_kind text DEFAULT 'manual'::text, _label text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_backup_id uuid;
  v_cadastros jsonb;
  v_automacao jsonb;
  v_usuarios jsonb;
  v_historico jsonb;
  v_meta jsonb;
  v_size bigint;
  v_user uuid := auth.uid();
  v_history_limit integer := 2000;
  v_commands_total integer := 0;
  v_agent_logs_total integer := 0;
  v_automation_log_total integer := 0;
  v_pump_runtime_total integer := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.farms f WHERE f.id = _farm_id) THEN
    RAISE EXCEPTION 'farm_not_found';
  END IF;

  -- Permissão: service_role (cron) OU platform_staff (admin/support) OU owner da fazenda
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT public.is_platform_staff(v_user)
     AND NOT public.has_farm_role(v_user, _farm_id, 'owner'::app_role) THEN
    RAISE EXCEPTION 'forbidden: somente equipe Renov ou owner da fazenda pode criar backup';
  END IF;

  SELECT jsonb_build_object(
    'plc_groups',  COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM public.plc_groups p WHERE p.farm_id = _farm_id), '[]'::jsonb),
    'sectors',     COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM public.sectors s WHERE s.farm_id = _farm_id), '[]'::jsonb),
    'equipments',  COALESCE((SELECT jsonb_agg(to_jsonb(e)) FROM public.equipments e WHERE e.farm_id = _farm_id), '[]'::jsonb),
    'rf_routing',  COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM public.rf_routing r WHERE r.farm_id = _farm_id), '[]'::jsonb)
  ) INTO v_cadastros;

  SELECT jsonb_build_object(
    'schedules',       COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM public.automation_schedules s WHERE s.farm_id = _farm_id), '[]'::jsonb),
    'engine',          COALESCE((SELECT jsonb_agg(to_jsonb(e)) FROM public.automation_engine e WHERE e.farm_id = _farm_id), '[]'::jsonb),
    'holiday_configs', COALESCE((SELECT jsonb_agg(to_jsonb(h)) FROM public.automation_holiday_configs h WHERE h.farm_id = _farm_id), '[]'::jsonb),
    'guards',          COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM public.automation_guards g WHERE g.farm_id = _farm_id), '[]'::jsonb)
  ) INTO v_automacao;

  SELECT jsonb_build_object(
    'user_roles', COALESCE((SELECT jsonb_agg(to_jsonb(ur)) FROM public.user_roles ur WHERE ur.farm_id = _farm_id), '[]'::jsonb),
    'profiles',   COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', p.id, 'email', p.email, 'full_name', p.full_name, 'phone', p.phone))
      FROM public.profiles p
      WHERE p.id IN (SELECT user_id FROM public.user_roles WHERE farm_id = _farm_id)
    ), '[]'::jsonb)
  ) INTO v_usuarios;

  SELECT count(*)::integer INTO v_commands_total
  FROM public.commands c
  WHERE c.farm_id = _farm_id AND c.created_at > now() - interval '90 days';

  SELECT count(*)::integer INTO v_agent_logs_total
  FROM public.agent_logs l
  WHERE l.farm_id = _farm_id AND l.created_at > now() - interval '90 days';

  SELECT count(*)::integer INTO v_automation_log_total
  FROM public.automation_log a
  WHERE a.farm_id = _farm_id AND a.occurred_at > now() - interval '90 days';

  SELECT count(*)::integer INTO v_pump_runtime_total
  FROM public.pump_runtime r
  WHERE r.farm_id = _farm_id AND r.started_at > now() - interval '90 days';

  SELECT jsonb_build_object(
    'commands', COALESCE((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC)
      FROM (
        SELECT * FROM public.commands c
        WHERE c.farm_id = _farm_id AND c.created_at > now() - interval '90 days'
        ORDER BY c.created_at DESC
        LIMIT v_history_limit
      ) x
    ), '[]'::jsonb),
    'agent_logs', COALESCE((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.created_at DESC)
      FROM (
        SELECT * FROM public.agent_logs l
        WHERE l.farm_id = _farm_id AND l.created_at > now() - interval '90 days'
        ORDER BY l.created_at DESC
        LIMIT v_history_limit
      ) x
    ), '[]'::jsonb),
    'automation_log', COALESCE((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.occurred_at DESC)
      FROM (
        SELECT * FROM public.automation_log a
        WHERE a.farm_id = _farm_id AND a.occurred_at > now() - interval '90 days'
        ORDER BY a.occurred_at DESC
        LIMIT v_history_limit
      ) x
    ), '[]'::jsonb),
    'pump_runtime', COALESCE((
      SELECT jsonb_agg(to_jsonb(x) ORDER BY x.started_at DESC)
      FROM (
        SELECT * FROM public.pump_runtime r
        WHERE r.farm_id = _farm_id AND r.started_at > now() - interval '90 days'
        ORDER BY r.started_at DESC
        LIMIT v_history_limit
      ) x
    ), '[]'::jsonb)
  ) INTO v_historico;

  v_meta := jsonb_build_object(
    'version', 2,
    'generated_at', now(),
    'history_limit_per_category', v_history_limit,
    'history_totals_90d', jsonb_build_object(
      'commands', v_commands_total,
      'agent_logs', v_agent_logs_total,
      'automation_log', v_automation_log_total,
      'pump_runtime', v_pump_runtime_total
    ),
    'counts', jsonb_build_object(
      'plc_groups',  jsonb_array_length(COALESCE(v_cadastros->'plc_groups', '[]'::jsonb)),
      'sectors',     jsonb_array_length(COALESCE(v_cadastros->'sectors', '[]'::jsonb)),
      'equipments',  jsonb_array_length(COALESCE(v_cadastros->'equipments', '[]'::jsonb)),
      'schedules',   jsonb_array_length(COALESCE(v_automacao->'schedules', '[]'::jsonb)),
      'user_roles',  jsonb_array_length(COALESCE(v_usuarios->'user_roles', '[]'::jsonb)),
      'commands',    jsonb_array_length(COALESCE(v_historico->'commands', '[]'::jsonb)),
      'agent_logs',  jsonb_array_length(COALESCE(v_historico->'agent_logs', '[]'::jsonb)),
      'automation_log', jsonb_array_length(COALESCE(v_historico->'automation_log', '[]'::jsonb)),
      'pump_runtime', jsonb_array_length(COALESCE(v_historico->'pump_runtime', '[]'::jsonb))
    )
  );

  v_size := octet_length(v_cadastros::text) + octet_length(v_automacao::text)
          + octet_length(v_usuarios::text)  + octet_length(v_historico::text);

  INSERT INTO public.farm_backups (farm_id, created_by, trigger_kind, label, size_bytes, cadastros, automacao, usuarios, historico, meta)
  VALUES (_farm_id, v_user, COALESCE(_trigger_kind, 'manual'), _label, v_size, v_cadastros, v_automacao, v_usuarios, v_historico, v_meta)
  RETURNING id INTO v_backup_id;

  RETURN v_backup_id;
END $function$;