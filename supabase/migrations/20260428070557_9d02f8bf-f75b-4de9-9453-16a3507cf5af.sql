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
BEGIN
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

  SELECT jsonb_build_object(
    'commands',       COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM public.commands c WHERE c.farm_id = _farm_id AND c.created_at > now() - interval '90 days'), '[]'::jsonb),
    'agent_logs',     COALESCE((SELECT jsonb_agg(to_jsonb(l)) FROM public.agent_logs l WHERE l.farm_id = _farm_id AND l.created_at > now() - interval '90 days'), '[]'::jsonb),
    'automation_log', COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM public.automation_log a WHERE a.farm_id = _farm_id AND a.occurred_at > now() - interval '90 days'), '[]'::jsonb),
    'pump_runtime',   COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM public.pump_runtime r WHERE r.farm_id = _farm_id AND r.started_at > now() - interval '90 days'), '[]'::jsonb)
  ) INTO v_historico;

  v_meta := jsonb_build_object(
    'version', 1,
    'generated_at', now(),
    'counts', jsonb_build_object(
      'plc_groups',  jsonb_array_length(COALESCE(v_cadastros->'plc_groups', '[]'::jsonb)),
      'sectors',     jsonb_array_length(COALESCE(v_cadastros->'sectors', '[]'::jsonb)),
      'equipments',  jsonb_array_length(COALESCE(v_cadastros->'equipments', '[]'::jsonb)),
      'schedules',   jsonb_array_length(COALESCE(v_automacao->'schedules', '[]'::jsonb)),
      'user_roles',  jsonb_array_length(COALESCE(v_usuarios->'user_roles', '[]'::jsonb)),
      'commands',    jsonb_array_length(COALESCE(v_historico->'commands', '[]'::jsonb)),
      'agent_logs',  jsonb_array_length(COALESCE(v_historico->'agent_logs', '[]'::jsonb))
    )
  );

  v_size := octet_length(v_cadastros::text) + octet_length(v_automacao::text)
          + octet_length(v_usuarios::text)  + octet_length(v_historico::text);

  INSERT INTO public.farm_backups (farm_id, created_by, trigger_kind, label, size_bytes, cadastros, automacao, usuarios, historico, meta)
  VALUES (_farm_id, v_user, COALESCE(_trigger_kind, 'manual'), _label, v_size, v_cadastros, v_automacao, v_usuarios, v_historico, v_meta)
  RETURNING id INTO v_backup_id;

  RETURN v_backup_id;
END $function$;