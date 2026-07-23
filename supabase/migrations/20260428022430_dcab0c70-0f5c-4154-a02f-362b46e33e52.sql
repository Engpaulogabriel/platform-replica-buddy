
-- ─────────────────────────────────────────────────────────────────
-- TABELA: farm_backups
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.farm_backups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  trigger_kind text NOT NULL DEFAULT 'manual', -- 'manual' | 'scheduled'
  label text,
  size_bytes bigint,
  -- Categorias separadas para permitir restauração seletiva sem precisar reler todo o JSON
  cadastros jsonb NOT NULL DEFAULT '{}'::jsonb,    -- plc_groups, sectors, equipments, rf_routing
  automacao jsonb NOT NULL DEFAULT '{}'::jsonb,    -- automation_schedules, automation_engine, automation_holiday_configs, automation_guards
  usuarios  jsonb NOT NULL DEFAULT '{}'::jsonb,    -- user_roles + profiles (nome/email vinculados)
  historico jsonb NOT NULL DEFAULT '{}'::jsonb,    -- commands, agent_logs, automation_log, pump_runtime (90d)
  meta jsonb NOT NULL DEFAULT '{}'::jsonb          -- contagens, versão, hash
);

CREATE INDEX IF NOT EXISTS idx_farm_backups_farm_created
  ON public.farm_backups(farm_id, created_at DESC);

ALTER TABLE public.farm_backups ENABLE ROW LEVEL SECURITY;

-- RLS: platform_staff lê tudo; owner da fazenda lê backups da própria fazenda
CREATE POLICY "farm_backups_select_platform_staff"
  ON public.farm_backups FOR SELECT TO authenticated
  USING (public.is_platform_staff(auth.uid()));

CREATE POLICY "farm_backups_select_farm_owner"
  ON public.farm_backups FOR SELECT TO authenticated
  USING (public.has_farm_role(auth.uid(), farm_id, 'owner'::app_role));

-- Inserts/deletes só via SECURITY DEFINER (sem policy de INSERT/DELETE direto)

-- ─────────────────────────────────────────────────────────────────
-- FUNCTION: farm_backup_create — cria snapshot de UMA fazenda
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.farm_backup_create(
  _farm_id uuid,
  _trigger_kind text DEFAULT 'manual',
  _label text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
  -- Permissão: platform_admin OU owner da fazenda OU service_role (cron)
  IF COALESCE(auth.role(), '') <> 'service_role'
     AND NOT public.is_platform_admin(v_user)
     AND NOT public.has_farm_role(v_user, _farm_id, 'owner'::app_role) THEN
    RAISE EXCEPTION 'forbidden: apenas owner da fazenda ou platform admin pode criar backup';
  END IF;

  -- 1) CADASTROS
  SELECT jsonb_build_object(
    'plc_groups',  COALESCE((SELECT jsonb_agg(to_jsonb(p)) FROM public.plc_groups p WHERE p.farm_id = _farm_id), '[]'::jsonb),
    'sectors',     COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM public.sectors s WHERE s.farm_id = _farm_id), '[]'::jsonb),
    'equipments',  COALESCE((SELECT jsonb_agg(to_jsonb(e)) FROM public.equipments e WHERE e.farm_id = _farm_id), '[]'::jsonb),
    'rf_routing',  COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM public.rf_routing r WHERE r.farm_id = _farm_id), '[]'::jsonb)
  ) INTO v_cadastros;

  -- 2) AUTOMAÇÃO
  SELECT jsonb_build_object(
    'schedules',       COALESCE((SELECT jsonb_agg(to_jsonb(s)) FROM public.automation_schedules s WHERE s.farm_id = _farm_id), '[]'::jsonb),
    'engine',          COALESCE((SELECT jsonb_agg(to_jsonb(e)) FROM public.automation_engine e WHERE e.farm_id = _farm_id), '[]'::jsonb),
    'holiday_configs', COALESCE((SELECT jsonb_agg(to_jsonb(h)) FROM public.automation_holiday_configs h WHERE h.farm_id = _farm_id), '[]'::jsonb),
    'guards',          COALESCE((SELECT jsonb_agg(to_jsonb(g)) FROM public.automation_guards g WHERE g.farm_id = _farm_id), '[]'::jsonb)
  ) INTO v_automacao;

  -- 3) USUÁRIOS (roles + dados de perfil para contexto)
  SELECT jsonb_build_object(
    'user_roles', COALESCE((SELECT jsonb_agg(to_jsonb(ur)) FROM public.user_roles ur WHERE ur.farm_id = _farm_id), '[]'::jsonb),
    'profiles',   COALESCE((
      SELECT jsonb_agg(jsonb_build_object('id', p.id, 'email', p.email, 'full_name', p.full_name, 'phone', p.phone))
      FROM public.profiles p
      WHERE p.id IN (SELECT user_id FROM public.user_roles WHERE farm_id = _farm_id)
    ), '[]'::jsonb)
  ) INTO v_usuarios;

  -- 4) HISTÓRICO (últimos 90d para não estourar tamanho)
  SELECT jsonb_build_object(
    'commands',       COALESCE((SELECT jsonb_agg(to_jsonb(c)) FROM public.commands c WHERE c.farm_id = _farm_id AND c.created_at > now() - interval '90 days'), '[]'::jsonb),
    'agent_logs',     COALESCE((SELECT jsonb_agg(to_jsonb(l)) FROM public.agent_logs l WHERE l.farm_id = _farm_id AND l.created_at > now() - interval '90 days'), '[]'::jsonb),
    'automation_log', COALESCE((SELECT jsonb_agg(to_jsonb(a)) FROM public.automation_log a WHERE a.farm_id = _farm_id AND a.occurred_at > now() - interval '90 days'), '[]'::jsonb),
    'pump_runtime',   COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM public.pump_runtime r WHERE r.farm_id = _farm_id AND r.started_at > now() - interval '90 days'), '[]'::jsonb)
  ) INTO v_historico;

  -- META: contagens
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
END $$;

-- ─────────────────────────────────────────────────────────────────
-- FUNCTION: farm_backup_restore — restauração SELETIVA por categoria
-- Sempre restringe por farm_id do snapshot — não toca outras fazendas
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.farm_backup_restore(
  _backup_id uuid,
  _restore_cadastros boolean DEFAULT true,
  _restore_automacao boolean DEFAULT true,
  _restore_usuarios  boolean DEFAULT false,
  _restore_historico boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bk RECORD;
  v_farm_id uuid;
  v_user uuid := auth.uid();
  v_counts jsonb := '{}'::jsonb;
  v_item jsonb;
BEGIN
  SELECT * INTO v_bk FROM public.farm_backups WHERE id = _backup_id;
  IF v_bk.id IS NULL THEN
    RAISE EXCEPTION 'backup_not_found';
  END IF;
  v_farm_id := v_bk.farm_id;

  IF NOT public.is_platform_admin(v_user)
     AND NOT public.has_farm_role(v_user, v_farm_id, 'owner'::app_role) THEN
    RAISE EXCEPTION 'forbidden: apenas owner da fazenda ou platform admin pode restaurar';
  END IF;

  -- Cria backup de segurança ANTES de restaurar
  PERFORM public.farm_backup_create(v_farm_id, 'pre-restore', 'Auto antes de restaurar ' || _backup_id::text);

  -- ─── CADASTROS ───
  IF _restore_cadastros THEN
    -- Deleta dependentes primeiro (FK lógica via farm_id)
    DELETE FROM public.equipments  WHERE farm_id = v_farm_id;
    DELETE FROM public.sectors     WHERE farm_id = v_farm_id;
    DELETE FROM public.plc_groups  WHERE farm_id = v_farm_id;
    DELETE FROM public.rf_routing  WHERE farm_id = v_farm_id;

    FOR v_item IN SELECT jsonb_array_elements(COALESCE(v_bk.cadastros->'plc_groups','[]'::jsonb)) LOOP
      INSERT INTO public.plc_groups (id, farm_id, name, hw_id, created_at, updated_at)
      VALUES (
        (v_item->>'id')::uuid, v_farm_id, v_item->>'name', v_item->>'hw_id',
        COALESCE((v_item->>'created_at')::timestamptz, now()),
        COALESCE((v_item->>'updated_at')::timestamptz, now())
      ) ON CONFLICT (id) DO NOTHING;
    END LOOP;

    FOR v_item IN SELECT jsonb_array_elements(COALESCE(v_bk.cadastros->'sectors','[]'::jsonb)) LOOP
      INSERT INTO public.sectors (id, farm_id, name, created_at, updated_at)
      VALUES (
        (v_item->>'id')::uuid, v_farm_id, v_item->>'name',
        COALESCE((v_item->>'created_at')::timestamptz, now()),
        COALESCE((v_item->>'updated_at')::timestamptz, now())
      ) ON CONFLICT (id) DO NOTHING;
    END LOOP;

    FOR v_item IN SELECT jsonb_array_elements(COALESCE(v_bk.cadastros->'equipments','[]'::jsonb)) LOOP
      INSERT INTO public.equipments (
        id, farm_id, hw_id, name, type, latitude, longitude, max_height,
        alarm_low, alarm_high, sector_id, plc_group_id, active, firmware_version,
        saida, horas_pico, max_horas_dia, demanda_kw, fonte_tipo, alimenta_id,
        polling_interval_seconds, created_at, updated_at
      ) VALUES (
        (v_item->>'id')::uuid, v_farm_id, v_item->>'hw_id', v_item->>'name',
        (v_item->>'type')::equipment_type,
        NULLIF(v_item->>'latitude','')::numeric, NULLIF(v_item->>'longitude','')::numeric,
        NULLIF(v_item->>'max_height','')::numeric,
        NULLIF(v_item->>'alarm_low','')::numeric, NULLIF(v_item->>'alarm_high','')::numeric,
        NULLIF(v_item->>'sector_id','')::uuid, NULLIF(v_item->>'plc_group_id','')::uuid,
        COALESCE((v_item->>'active')::boolean, true), v_item->>'firmware_version',
        NULLIF(v_item->>'saida','')::smallint, v_item->>'horas_pico',
        NULLIF(v_item->>'max_horas_dia','')::numeric, NULLIF(v_item->>'demanda_kw','')::numeric,
        v_item->>'fonte_tipo', NULLIF(v_item->>'alimenta_id','')::uuid,
        COALESCE(NULLIF(v_item->>'polling_interval_seconds','')::int, 8),
        COALESCE((v_item->>'created_at')::timestamptz, now()),
        COALESCE((v_item->>'updated_at')::timestamptz, now())
      ) ON CONFLICT (id) DO NOTHING;
    END LOOP;

    FOR v_item IN SELECT jsonb_array_elements(COALESCE(v_bk.cadastros->'rf_routing','[]'::jsonb)) LOOP
      INSERT INTO public.rf_routing (farm_id, radio, via_repetidor, updated_at)
      VALUES (v_farm_id, COALESCE(v_item->>'radio','R1'), COALESCE((v_item->>'via_repetidor')::boolean, false), now())
      ON CONFLICT (farm_id) DO UPDATE SET radio = EXCLUDED.radio, via_repetidor = EXCLUDED.via_repetidor, updated_at = now();
    END LOOP;

    v_counts := v_counts || jsonb_build_object('cadastros', 'restaurado');
  END IF;

  -- ─── AUTOMAÇÃO ───
  IF _restore_automacao THEN
    DELETE FROM public.automation_schedules       WHERE farm_id = v_farm_id;
    DELETE FROM public.automation_engine          WHERE farm_id = v_farm_id;
    DELETE FROM public.automation_holiday_configs WHERE farm_id = v_farm_id;
    DELETE FROM public.automation_guards          WHERE farm_id = v_farm_id;

    FOR v_item IN SELECT jsonb_array_elements(COALESCE(v_bk.automacao->'schedules','[]'::jsonb)) LOOP
      INSERT INTO public.automation_schedules (id, farm_id, equipment_id, mode, days, time_on, time_off, active, created_by, created_at, updated_at)
      VALUES (
        (v_item->>'id')::uuid, v_farm_id, (v_item->>'equipment_id')::uuid,
        COALESCE(v_item->>'mode','on-only'),
        ARRAY(SELECT jsonb_array_elements_text(COALESCE(v_item->'days','[]'::jsonb))),
        v_item->>'time_on', v_item->>'time_off',
        COALESCE((v_item->>'active')::boolean, true),
        NULLIF(v_item->>'created_by','')::uuid,
        COALESCE((v_item->>'created_at')::timestamptz, now()),
        COALESCE((v_item->>'updated_at')::timestamptz, now())
      ) ON CONFLICT (id) DO NOTHING;
    END LOOP;

    FOR v_item IN SELECT jsonb_array_elements(COALESCE(v_bk.automacao->'engine','[]'::jsonb)) LOOP
      INSERT INTO public.automation_engine (farm_id, enabled, updated_at)
      VALUES (v_farm_id, COALESCE((v_item->>'enabled')::boolean, true), now())
      ON CONFLICT (farm_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now();
    END LOOP;

    FOR v_item IN SELECT jsonb_array_elements(COALESCE(v_bk.automacao->'holiday_configs','[]'::jsonb)) LOOP
      INSERT INTO public.automation_holiday_configs (id, farm_id, equipment_id, enabled, mode, special_time_on, special_time_off, created_at, updated_at)
      VALUES (
        (v_item->>'id')::uuid, v_farm_id, (v_item->>'equipment_id')::uuid,
        COALESCE((v_item->>'enabled')::boolean, false),
        COALESCE(v_item->>'mode','free-demand'),
        COALESCE(v_item->>'special_time_on','06:00'),
        COALESCE(v_item->>'special_time_off','22:00'),
        COALESCE((v_item->>'created_at')::timestamptz, now()),
        COALESCE((v_item->>'updated_at')::timestamptz, now())
      ) ON CONFLICT (id) DO NOTHING;
    END LOOP;

    v_counts := v_counts || jsonb_build_object('automacao', 'restaurado');
  END IF;

  -- ─── USUÁRIOS ───
  IF _restore_usuarios THEN
    DELETE FROM public.user_roles WHERE farm_id = v_farm_id;
    FOR v_item IN SELECT jsonb_array_elements(COALESCE(v_bk.usuarios->'user_roles','[]'::jsonb)) LOOP
      INSERT INTO public.user_roles (id, user_id, farm_id, role, created_at)
      VALUES (
        COALESCE(NULLIF(v_item->>'id','')::uuid, gen_random_uuid()),
        (v_item->>'user_id')::uuid, v_farm_id,
        (v_item->>'role')::app_role,
        COALESCE((v_item->>'created_at')::timestamptz, now())
      ) ON CONFLICT DO NOTHING;
    END LOOP;
    v_counts := v_counts || jsonb_build_object('usuarios', 'restaurado');
  END IF;

  -- ─── HISTÓRICO ───
  -- Não restaura por padrão (seria invasivo); só cria registro de log informando.
  -- Mantemos a flag mas não fazemos rewrite destrutivo de histórico operacional.
  IF _restore_historico THEN
    -- Insere entradas históricas que NÃO existirem (preserva atual + traz antigas)
    FOR v_item IN SELECT jsonb_array_elements(COALESCE(v_bk.historico->'pump_runtime','[]'::jsonb)) LOOP
      INSERT INTO public.pump_runtime (id, farm_id, equipment_id, started_at, ended_at, duration_seconds, created_at)
      VALUES (
        (v_item->>'id')::uuid, v_farm_id, (v_item->>'equipment_id')::uuid,
        (v_item->>'started_at')::timestamptz,
        NULLIF(v_item->>'ended_at','')::timestamptz,
        NULLIF(v_item->>'duration_seconds','')::int,
        COALESCE((v_item->>'created_at')::timestamptz, now())
      ) ON CONFLICT (id) DO NOTHING;
    END LOOP;
    v_counts := v_counts || jsonb_build_object('historico', 'pump_runtime mesclado');
  END IF;

  INSERT INTO public.agent_logs (farm_id, level, category, message)
  VALUES (v_farm_id, 'warn', 'backup',
    format('Restauração executada do backup %s por %s. Categorias: cadastros=%s automacao=%s usuarios=%s historico=%s',
      _backup_id, v_user, _restore_cadastros, _restore_automacao, _restore_usuarios, _restore_historico));

  RETURN jsonb_build_object('ok', true, 'farm_id', v_farm_id, 'restored', v_counts);
END $$;

-- ─────────────────────────────────────────────────────────────────
-- FUNCTION: farm_backup_purge_old — apaga snapshots > 30 dias
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.farm_backup_purge_old()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_count integer;
BEGIN
  WITH del AS (
    DELETE FROM public.farm_backups
    WHERE created_at < now() - interval '30 days'
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM del;
  RETURN COALESCE(v_count, 0);
END $$;

-- ─────────────────────────────────────────────────────────────────
-- FUNCTION: farm_backup_list — lista resumida (sem o JSON gigante)
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.farm_backup_list(_farm_id uuid)
RETURNS TABLE (
  id uuid, farm_id uuid, created_at timestamptz, created_by uuid,
  trigger_kind text, label text, size_bytes bigint, meta jsonb
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT public.is_platform_staff(auth.uid())
     AND NOT public.has_farm_role(auth.uid(), _farm_id, 'owner'::app_role) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  RETURN QUERY
  SELECT b.id, b.farm_id, b.created_at, b.created_by, b.trigger_kind, b.label, b.size_bytes, b.meta
  FROM public.farm_backups b
  WHERE b.farm_id = _farm_id
  ORDER BY b.created_at DESC;
END $$;

-- ─────────────────────────────────────────────────────────────────
-- FUNCTION: farm_backup_create_all_farms — usado pelo cron diário
-- ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.farm_backup_create_all_farms()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_farm RECORD;
  v_count int := 0;
BEGIN
  FOR v_farm IN SELECT id FROM public.farms LOOP
    BEGIN
      PERFORM public.farm_backup_create(v_farm.id, 'scheduled', 'Backup diário automático');
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.agent_logs (farm_id, level, category, message)
      VALUES (v_farm.id, 'error', 'backup', 'Falha no backup diário: ' || SQLERRM);
    END;
  END LOOP;
  -- Limpa antigos depois
  PERFORM public.farm_backup_purge_old();
  RETURN v_count;
END $$;
