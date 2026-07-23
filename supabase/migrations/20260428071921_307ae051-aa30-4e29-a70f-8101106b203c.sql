CREATE OR REPLACE FUNCTION public.farm_backup_create(_farm_id uuid, _trigger_kind text DEFAULT 'manual'::text, _label text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
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
  v_history_limit integer := 1000;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.farms f WHERE f.id = _farm_id) THEN
    RAISE EXCEPTION 'farm_not_found';
  END IF;

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
    'commands', COALESCE((
      SELECT jsonb_agg(to_jsonb(x)) FROM (
        SELECT * FROM public.commands
        WHERE farm_id = _farm_id
        ORDER BY created_at DESC
        LIMIT v_history_limit
      ) x
    ), '[]'::jsonb),
    'agent_logs', COALESCE((
      SELECT jsonb_agg(to_jsonb(x)) FROM (
        SELECT * FROM public.agent_logs
        WHERE farm_id = _farm_id
        ORDER BY created_at DESC
        LIMIT v_history_limit
      ) x
    ), '[]'::jsonb),
    'automation_log', COALESCE((
      SELECT jsonb_agg(to_jsonb(x)) FROM (
        SELECT * FROM public.automation_log
        WHERE farm_id = _farm_id
        ORDER BY created_at DESC
        LIMIT v_history_limit
      ) x
    ), '[]'::jsonb),
    'pump_runtime', COALESCE((
      SELECT jsonb_agg(to_jsonb(x)) FROM (
        SELECT * FROM public.pump_runtime
        WHERE farm_id = _farm_id
        ORDER BY started_at DESC
        LIMIT v_history_limit
      ) x
    ), '[]'::jsonb)
  ) INTO v_historico;

  v_meta := jsonb_build_object(
    'history_limit_per_table', v_history_limit,
    'note', 'Histórico limitado aos N registros mais recentes para garantir performance.'
  );

  v_size := octet_length(v_cadastros::text)
          + octet_length(v_automacao::text)
          + octet_length(v_usuarios::text)
          + octet_length(v_historico::text);

  INSERT INTO public.farm_backups (farm_id, trigger_kind, label, cadastros, automacao, usuarios, historico, meta, size_bytes, created_by)
  VALUES (_farm_id, _trigger_kind, _label, v_cadastros, v_automacao, v_usuarios, v_historico, v_meta, v_size, v_user)
  RETURNING id INTO v_backup_id;

  RETURN v_backup_id;
END;
$function$;

CREATE INDEX IF NOT EXISTS idx_commands_farm_created ON public.commands (farm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_logs_farm_created ON public.agent_logs (farm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_log_farm_created ON public.automation_log (farm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pump_runtime_farm_started ON public.pump_runtime (farm_id, started_at DESC);

REVOKE ALL ON FUNCTION public.farm_backup_create(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_backup_create(uuid, text, text) TO authenticated, service_role;