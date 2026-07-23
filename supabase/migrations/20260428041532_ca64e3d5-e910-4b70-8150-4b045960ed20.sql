-- ═══════════════════════════════════════════════════════════════════════════
-- MODO DEMONSTRAÇÃO — FASE 1: Schema + seed (V4 — final)
-- Correção: automation_log.client_event_id é NOT NULL → preenche com gen_random_uuid()
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Marcador
ALTER TABLE public.farms
  ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_farms_is_demo ON public.farms(is_demo) WHERE is_demo = true;

-- 2) Acesso staff às fazendas demo
CREATE OR REPLACE FUNCTION public.has_farm_access(_user_id uuid, _farm_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND farm_id = _farm_id)
    OR (
      public.is_platform_staff(_user_id)
      AND EXISTS (SELECT 1 FROM public.farms WHERE id = _farm_id AND is_demo = true)
    );
$$;

CREATE OR REPLACE FUNCTION public.can_write_farm(_user_id uuid, _farm_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = _user_id AND farm_id = _farm_id
        AND role IN ('owner','admin','operator')
    )
    OR (
      public.is_platform_staff(_user_id)
      AND EXISTS (SELECT 1 FROM public.farms WHERE id = _farm_id AND is_demo = true)
    );
$$;

-- 3) platform_farms_overview — adiciona is_demo
DROP FUNCTION IF EXISTS public.platform_farms_overview();
CREATE FUNCTION public.platform_farms_overview()
RETURNS TABLE(
  farm_id uuid, name text, city text, state text, plan text,
  license_key text, created_at timestamptz, equipments_count integer,
  users_count integer, agent_status text, last_heartbeat timestamptz,
  com_connected boolean, pending_commands integer, is_demo boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_platform_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  RETURN QUERY
  SELECT
    f.id, f.name, f.city, f.state, f.plan, f.license_key, f.created_at,
    (SELECT count(*)::int FROM public.equipments e WHERE e.farm_id = f.id AND e.active),
    (SELECT count(*)::int FROM public.user_roles ur WHERE ur.farm_id = f.id),
    COALESCE(sh.agent_status, 'offline'),
    sh.last_heartbeat,
    COALESCE(sh.com_connected, false),
    (SELECT count(*)::int FROM public.commands c WHERE c.farm_id = f.id AND c.status IN ('pending','sent')),
    f.is_demo
  FROM public.farms f
  LEFT JOIN LATERAL (
    SELECT * FROM public.site_health s WHERE s.farm_id = f.id ORDER BY s.last_heartbeat DESC NULLS LAST LIMIT 1
  ) sh ON true
  ORDER BY f.created_at DESC;
END $$;

-- 4) Dropdown "Modo Demonstração"
CREATE OR REPLACE FUNCTION public.platform_list_demo_farms()
RETURNS TABLE (
  farm_id uuid, name text, city text, state text, plan text,
  equipments_count bigint, description text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    f.id, f.name, f.city, f.state, f.plan,
    (SELECT count(*) FROM public.equipments e WHERE e.farm_id = f.id),
    CASE
      WHEN f.plan = 'lite' THEN 'Demo enxuta — 4 bombas, ideal para reuniões rápidas'
      ELSE 'Demo completa — 8 bombas, 3 setores, horímetro 30d, automação COELBA'
    END
  FROM public.farms f
  WHERE f.is_demo = true
    AND public.is_platform_staff(auth.uid())
  ORDER BY f.plan, f.name;
$$;

GRANT EXECUTE ON FUNCTION public.platform_list_demo_farms() TO authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- 5) DEMO 1 — Apresentação
-- ──────────────────────────────────────────────────────────────────────────
DO $seed1$
DECLARE v_farm1 uuid; v_plc1 uuid; v_sec1 uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.farms WHERE name = 'Demo Renov — Apresentação' AND is_demo = true) THEN RETURN; END IF;

  INSERT INTO public.farms (name, city, state, plan, license_status, is_demo, modules)
  VALUES ('Demo Renov — Apresentação', 'Petrolina', 'PE', 'lite', 'active', true,
          jsonb_build_object('vazao', false, 'consumo', false, 'ai_whatsapp', false))
  RETURNING id INTO v_farm1;

  INSERT INTO public.plc_groups (farm_id, hw_id, name) VALUES (v_farm1, '9001', 'PLC Demo') RETURNING id INTO v_plc1;
  INSERT INTO public.sectors (farm_id, name) VALUES (v_farm1, 'Irrigação Norte') RETURNING id INTO v_sec1;

  INSERT INTO public.equipments (farm_id, plc_group_id, sector_id, hw_id, name, type, saida, latitude, longitude, polling_interval_seconds)
  VALUES
    (v_farm1, v_plc1, v_sec1, '900101', 'Poço Profundo',  'poco',        1, -9.3891, -40.5030, 8),
    (v_farm1, v_plc1, v_sec1, '900102', 'Recalque',       'bombeamento', 2, -9.3895, -40.5025, 8),
    (v_farm1, v_plc1, v_sec1, '900103', 'Pressurização', 'bombeamento', 3, -9.3899, -40.5020, 8),
    (v_farm1, v_plc1, v_sec1, '900104', 'Reserva',        'bombeamento', 4, -9.3902, -40.5015, 8);

  INSERT INTO public.equipments (farm_id, hw_id, name, type, max_height, alarm_low, alarm_high, latitude, longitude)
  VALUES
    (v_farm1, '900150', 'Reservatório Principal',  'nivel', 5.0, 1.0, 4.5, -9.3893, -40.5028),
    (v_farm1, '900151', 'Reservatório Secundário', 'nivel', 3.5, 0.7, 3.2, -9.3897, -40.5023);
END $seed1$;

-- ──────────────────────────────────────────────────────────────────────────
-- 6) DEMO 2 — Enterprise
-- ──────────────────────────────────────────────────────────────────────────
DO $seed2$
DECLARE
  v_farm2 uuid; v_plcA uuid; v_plcB uuid;
  v_secN uuid; v_secS uuid; v_secP uuid;
  v_eq record; v_day int; v_start timestamptz;
  v_dias text[] := ARRAY['mon','tue','wed','thu','fri','sat','sun'];
BEGIN
  IF EXISTS (SELECT 1 FROM public.farms WHERE name = 'Demo Renov — Enterprise' AND is_demo = true) THEN RETURN; END IF;

  INSERT INTO public.farms (name, city, state, plan, license_status, is_demo, modules)
  VALUES ('Demo Renov — Enterprise', 'Barreiras', 'BA', 'pro', 'active', true,
          jsonb_build_object('vazao', true, 'consumo', true, 'ai_whatsapp', true))
  RETURNING id INTO v_farm2;

  INSERT INTO public.plc_groups (farm_id, hw_id, name) VALUES (v_farm2, '8001', 'PLC Norte') RETURNING id INTO v_plcA;
  INSERT INTO public.plc_groups (farm_id, hw_id, name) VALUES (v_farm2, '8002', 'PLC Sul/Pivô') RETURNING id INTO v_plcB;

  INSERT INTO public.sectors (farm_id, name) VALUES (v_farm2, 'Setor Norte')   RETURNING id INTO v_secN;
  INSERT INTO public.sectors (farm_id, name) VALUES (v_farm2, 'Setor Sul')     RETURNING id INTO v_secS;
  INSERT INTO public.sectors (farm_id, name) VALUES (v_farm2, 'Pivô Central')  RETURNING id INTO v_secP;

  INSERT INTO public.equipments (farm_id, plc_group_id, sector_id, hw_id, name, type, saida, latitude, longitude, polling_interval_seconds, demanda_kw)
  VALUES
    (v_farm2, v_plcA, v_secN, '800101', 'Poço Norte 1',     'poco',        1, -12.1530, -45.0050, 8, 75),
    (v_farm2, v_plcA, v_secN, '800102', 'Poço Norte 2',     'poco',        2, -12.1535, -45.0045, 8, 75),
    (v_farm2, v_plcA, v_secN, '800103', 'Recalque Norte',   'bombeamento', 3, -12.1540, -45.0040, 8, 110),
    (v_farm2, v_plcA, v_secS, '800104', 'Poço Sul 1',       'poco',        4, -12.1620, -45.0080, 8, 75),
    (v_farm2, v_plcA, v_secS, '800105', 'Poço Sul 2',       'poco',        5, -12.1625, -45.0075, 8, 75),
    (v_farm2, v_plcA, v_secS, '800106', 'Recalque Sul',     'bombeamento', 6, -12.1630, -45.0070, 8, 110),
    (v_farm2, v_plcB, v_secP, '800201', 'Pivô Central A',   'bombeamento', 1, -12.1580, -45.0060, 8, 150),
    (v_farm2, v_plcB, v_secP, '800202', 'Pivô Central B',   'bombeamento', 2, -12.1585, -45.0055, 8, 150);

  INSERT INTO public.equipments (farm_id, hw_id, name, type, max_height, alarm_low, alarm_high, latitude, longitude)
  VALUES
    (v_farm2, '800150', 'Reservatório Principal',  'nivel', 8.0, 1.5, 7.5, -12.1545, -45.0035),
    (v_farm2, '800151', 'Reservatório Secundário', 'nivel', 6.0, 1.2, 5.5, -12.1550, -45.0030),
    (v_farm2, '800152', 'Reservatório Elevado',    'nivel', 4.0, 0.8, 3.7, -12.1555, -45.0025),
    (v_farm2, '800153', 'Cisterna',                'nivel', 5.0, 1.0, 4.7, -12.1560, -45.0020);

  -- Schedules COELBA: on-only 21:30 + off-only 06:00, todos os dias
  FOR v_eq IN
    SELECT id FROM public.equipments WHERE farm_id = v_farm2 AND type IN ('poco','bombeamento')
  LOOP
    INSERT INTO public.automation_schedules (farm_id, equipment_id, time_on, time_off, days, mode, active)
    VALUES (v_farm2, v_eq.id, '21:30', '21:30', v_dias, 'on-only',  true);
    INSERT INTO public.automation_schedules (farm_id, equipment_id, time_on, time_off, days, mode, active)
    VALUES (v_farm2, v_eq.id, '06:00', '06:00', v_dias, 'off-only', true);
  END LOOP;

  INSERT INTO public.automation_engine (farm_id, enabled) VALUES (v_farm2, true);

  -- Horímetro fictício 30 dias
  FOR v_eq IN
    SELECT id FROM public.equipments WHERE farm_id = v_farm2 AND type IN ('poco','bombeamento')
  LOOP
    FOR v_day IN 1..30 LOOP
      v_start := (now()::date - v_day) + interval '21 hours 30 minutes';
      INSERT INTO public.pump_runtime (farm_id, equipment_id, started_at, ended_at, duration_seconds)
      VALUES (v_farm2, v_eq.id, v_start, v_start + interval '8 hours 30 minutes', 30600);
    END LOOP;
  END LOOP;

  -- automation_log: liga/desliga últimos 7 dias (client_event_id obrigatório)
  FOR v_eq IN
    SELECT id, name FROM public.equipments WHERE farm_id = v_farm2 AND type IN ('poco','bombeamento')
  LOOP
    FOR v_day IN 1..7 LOOP
      INSERT INTO public.automation_log (farm_id, equipment_id, equipment_name, action, origin, result, occurred_at, new_state, client_event_id)
      VALUES
        (v_farm2, v_eq.id, v_eq.name, 'turn_on',  'auto', 'success', (now()::date - v_day) + interval '21 hours 30 minutes', 'on',  gen_random_uuid()),
        (v_farm2, v_eq.id, v_eq.name, 'turn_off', 'auto', 'success', (now()::date - v_day) + interval '1 day' + interval '6 hours', 'off', gen_random_uuid());
    END LOOP;
  END LOOP;

  INSERT INTO public.site_health (farm_id, agent_status, last_heartbeat, com_connected, com_port, agent_version, uptime_seconds)
  VALUES (v_farm2, 'online', now(), true, 'COM3', 'demo-1.0.0', 432000);
END $seed2$;