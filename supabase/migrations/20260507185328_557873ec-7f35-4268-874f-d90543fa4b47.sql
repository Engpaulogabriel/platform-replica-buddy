ALTER TABLE public.plc_groups ALTER COLUMN output_count SET DEFAULT 1;

CREATE OR REPLACE FUNCTION public.enforce_single_output_plc_for_equipment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.plc_group_id IS NOT NULL AND NEW.type IN ('poco', 'nivel') THEN
    UPDATE public.plc_groups
    SET output_count = 1,
        updated_at = now()
    WHERE id = NEW.plc_group_id
      AND output_count IS DISTINCT FROM 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS equipments_enforce_single_output_plc ON public.equipments;
CREATE TRIGGER equipments_enforce_single_output_plc
AFTER INSERT OR UPDATE OF type, plc_group_id ON public.equipments
FOR EACH ROW
EXECUTE FUNCTION public.enforce_single_output_plc_for_equipment();

DO $$
DECLARE
  v_sql text;
BEGIN
  v_sql := pg_get_functiondef('public.enqueue_polling_for_due_equipments_internal(uuid)'::regprocedure);
  v_sql := replace(v_sql,
    'v_plc_total := GREATEST(v_max_saida, COALESCE(v_plc.plc_total, 1));',
    'v_plc_total := COALESCE(v_plc.plc_total, 1);'
  );
  EXECUTE v_sql;

  v_sql := pg_get_functiondef('public.enqueue_startup_sync_polling(uuid)'::regprocedure);
  v_sql := replace(v_sql,
    'v_plc_total := GREATEST(v_max_saida, COALESCE(v_plc.plc_total, 1));',
    'v_plc_total := COALESCE(v_plc.plc_total, 1);'
  );
  EXECUTE v_sql;

  v_sql := pg_get_functiondef('public.enqueue_reset_pump_command(uuid,uuid,text)'::regprocedure);
  v_sql := replace(v_sql,
    'v_total := GREATEST(v_eq.plc_total, COALESCE(v_eq.saida, 1));',
    'v_total := COALESCE(v_eq.plc_total, 1);'
  );
  EXECUTE v_sql;

  v_sql := pg_get_functiondef('public.run_automation_tick()'::regprocedure);
  v_sql := replace(v_sql,
    'v_plc_total := GREATEST(v_sched.plc_total, COALESCE(v_sched.saida, 1));',
    'v_plc_total := COALESCE(v_sched.plc_total, 1);'
  );
  EXECUTE v_sql;
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_create_farm_full(
  _name text,
  _owner_email text,
  _city text DEFAULT NULL,
  _state text DEFAULT NULL,
  _timezone text DEFAULT 'America/Sao_Paulo',
  _plan text DEFAULT 'lite'
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_farm_id uuid;
  v_owner_id uuid;
  v_license text;
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden: apenas platform admin';
  END IF;

  SELECT id INTO v_owner_id FROM auth.users WHERE lower(email) = lower(_owner_email) LIMIT 1;
  IF v_owner_id IS NULL THEN
    RAISE EXCEPTION 'usuario_owner_nao_encontrado: convide o usuario primeiro pelo Auth';
  END IF;

  v_license := 'RNV-' || upper(substring(replace(gen_random_uuid()::text,'-','') from 1 for 16));

  INSERT INTO public.farms (name, city, state, timezone, plan, license_key)
  VALUES (_name, _city, _state, _timezone, _plan, v_license)
  RETURNING id INTO v_farm_id;

  INSERT INTO public.user_roles (user_id, farm_id, role)
  VALUES (v_owner_id, v_farm_id, 'owner')
  ON CONFLICT DO NOTHING;

  INSERT INTO public.farm_timing_config (
    farm_id,
    default_polling_seconds,
    default_command_timeout_ms,
    agent_backoff_seconds,
    agent_backoff_after_timeouts,
    auto_reset_minutes,
    offline_levels_seconds,
    offline_auto_seconds,
    comm_levels_seconds,
    comm_system_seconds
  )
  SELECT
    v_farm_id,
    COALESCE(t.default_polling_seconds, 8),
    COALESCE(t.default_command_timeout_ms, 10000),
    COALESCE(t.agent_backoff_seconds, 60),
    COALESCE(t.agent_backoff_after_timeouts, 3),
    COALESCE(t.auto_reset_minutes, 2),
    COALESCE(t.offline_levels_seconds, 60),
    COALESCE(t.offline_auto_seconds, 1200),
    COALESCE(t.comm_levels_seconds, 10),
    COALESCE(t.comm_system_seconds, 3)
  FROM (VALUES (1)) seed(n)
  LEFT JOIN LATERAL (
    SELECT ftc.*
    FROM public.farms tf
    LEFT JOIN public.farm_timing_config ftc ON ftc.farm_id = tf.id
    WHERE tf.name ILIKE '%terra norte%'
    ORDER BY tf.created_at ASC
    LIMIT 1
  ) t ON true
  ON CONFLICT (farm_id) DO NOTHING;

  UPDATE public.profiles
    SET default_farm_id = v_farm_id
    WHERE id = v_owner_id AND default_farm_id IS NULL;

  RETURN v_farm_id;
END $$;