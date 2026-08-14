-- ============================================================================
-- COMUNICAÇÃO ASSISTIDA POR POÇO — piloto Sykue. OPT-IN, nasce DESLIGADA.
-- ----------------------------------------------------------------------------
-- Muda SOMENTE a prioridade de LEITURA de telemetria do poço ativado. Não toca
-- estado físico, cores, regra de Offline de 15 min, dashboard do cliente,
-- Realtime, Relatório de Automação, autoria, proteção de comutação, manutenção,
-- protocolo PLC, frame, rádio, bridge, TX espontâneo, Ligar/Desligar, timeout
-- de 120s, automações, FASE 2/3 nem OTA.
--
-- Toda a frota permanece no ciclo atual: a coluna nasce false em TODO
-- equipamento, inclusive nos dois poços do piloto.
-- ============================================================================

-- ── 1) Configuração por equipamento ─────────────────────────────────────────
ALTER TABLE public.equipments
  ADD COLUMN IF NOT EXISTS adaptive_telemetry_enabled    boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS adaptive_telemetry_profile    text    NOT NULL DEFAULT 'conservador',
  ADD COLUMN IF NOT EXISTS adaptive_telemetry_updated_at timestamptz,
  ADD COLUMN IF NOT EXISTS adaptive_telemetry_updated_by uuid;

COMMENT ON COLUMN public.equipments.adaptive_telemetry_enabled IS
  'Comunicação Assistida: OPT-IN por poço, desligada por padrão. Só altera prioridade de LEITURA — nunca comanda relé.';

-- Perfis com limites conservadores. Alterar aqui muda a política sem tocar no agente.
CREATE TABLE IF NOT EXISTS public.adaptive_telemetry_profiles (
  name                text PRIMARY KEY,
  attention_min       int  NOT NULL DEFAULT 8,    -- entra em Atenção
  recovery_min        int  NOT NULL DEFAULT 11,   -- entra em Recuperação
  critical_min        int  NOT NULL DEFAULT 13,   -- entra em Crítico
  offline_min         int  NOT NULL DEFAULT 15,   -- Offline real (regra atual, não muda)
  normals_attention   int  NOT NULL DEFAULT 3,    -- leituras normais entre retries
  normals_recovery    int  NOT NULL DEFAULT 2,
  normals_critical    int  NOT NULL DEFAULT 1,
  retry_budget_pct    int  NOT NULL DEFAULT 20    -- teto de retries por rodada
    CHECK (retry_budget_pct BETWEEN 1 AND 50)
);
INSERT INTO public.adaptive_telemetry_profiles (name) VALUES ('conservador')
ON CONFLICT (name) DO NOTHING;

-- ── 2) Auditoria de ativação/desativação ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.adaptive_telemetry_audit (
  id           bigserial PRIMARY KEY,
  equipment_id uuid NOT NULL,
  farm_id      uuid,
  enabled      boolean NOT NULL,
  profile      text,
  changed_by   uuid NOT NULL,
  changed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_adaptive_audit_equip
  ON public.adaptive_telemetry_audit (equipment_id, changed_at DESC);
ALTER TABLE public.adaptive_telemetry_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS adaptive_audit_select ON public.adaptive_telemetry_audit;
CREATE POLICY adaptive_audit_select ON public.adaptive_telemetry_audit
  FOR SELECT TO authenticated USING (public.is_platform_staff(auth.uid()));

-- ── 3) Log técnico das decisões do escalonador (retenção 30 dias) ───────────
CREATE TABLE IF NOT EXISTS public.adaptive_telemetry_log (
  id                  bigserial PRIMARY KEY,
  farm_id             uuid NOT NULL,
  equipment_id        uuid NOT NULL,
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  risk_band           text NOT NULL,       -- normal|attention|recovery|critical|offline
  reason              text NOT NULL,       -- por que priorizou
  attempt_sent        boolean NOT NULL DEFAULT false,
  outcome             text,                -- success|fail|timeout|skipped
  seconds_since_reply int,
  budget_used_pct     int,
  had_pending_command boolean NOT NULL DEFAULT false,
  agent_version       text
);
CREATE INDEX IF NOT EXISTS idx_adaptive_log_equip
  ON public.adaptive_telemetry_log (equipment_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_adaptive_log_farm
  ON public.adaptive_telemetry_log (farm_id, occurred_at DESC);
ALTER TABLE public.adaptive_telemetry_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS adaptive_log_select ON public.adaptive_telemetry_log;
CREATE POLICY adaptive_log_select ON public.adaptive_telemetry_log
  FOR SELECT TO authenticated USING (public.is_platform_staff(auth.uid()));

CREATE OR REPLACE FUNCTION public.purge_adaptive_telemetry_log(_keep interval DEFAULT interval '30 days')
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  DELETE FROM public.adaptive_telemetry_log WHERE occurred_at < now() - _keep;
  GET DIAGNOSTICS n = ROW_COUNT; RETURN n;
END; $$;

-- ── 4) Configuração: único caminho, restrito a staff técnico ────────────────
CREATE OR REPLACE FUNCTION public.set_adaptive_telemetry(
  _equipment_id uuid, _enabled boolean, _profile text DEFAULT 'conservador',
  _actor uuid DEFAULT NULL)
RETURNS TABLE (equipment_id uuid, enabled boolean, profile text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := COALESCE(_actor, auth.uid()); v_farm uuid;
BEGIN
  IF NOT public.is_platform_staff(v_actor) THEN
    RAISE EXCEPTION 'somente platform_admin ou técnico (platform_support) pode configurar a Comunicação Assistida';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.adaptive_telemetry_profiles p WHERE p.name = _profile) THEN
    RAISE EXCEPTION 'perfil % não existe', _profile;
  END IF;

  UPDATE public.equipments e
     SET adaptive_telemetry_enabled = _enabled,
         adaptive_telemetry_profile = _profile,
         adaptive_telemetry_updated_at = now(),
         adaptive_telemetry_updated_by = v_actor
   WHERE e.id = _equipment_id
  RETURNING e.farm_id INTO v_farm;
  IF v_farm IS NULL THEN RAISE EXCEPTION 'equipamento % não existe', _equipment_id; END IF;

  INSERT INTO public.adaptive_telemetry_audit (equipment_id, farm_id, enabled, profile, changed_by)
  VALUES (_equipment_id, v_farm, _enabled, _profile, v_actor);

  RETURN QUERY SELECT _equipment_id, _enabled, _profile;
END; $$;
GRANT EXECUTE ON FUNCTION public.set_adaptive_telemetry(uuid, boolean, text, uuid) TO authenticated, service_role;

-- ── 5) Painel técnico: saúde por poço ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.adaptive_telemetry_health(_farm_id uuid)
RETURNS TABLE (
  equipment_id uuid, equipamento text, assistida boolean,
  ultima_resposta timestamptz, minutos_sem_resposta numeric,
  estado text, falhas_consecutivas bigint, retries_24h bigint,
  max_sem_resposta_24h_min numeric, alterado_em timestamptz, alterado_por text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.id, e.name,
    COALESCE(e.adaptive_telemetry_enabled,false),
    e.last_communication,
    ROUND(EXTRACT(EPOCH FROM (now() - e.last_communication))/60.0, 1),
    CASE
      WHEN e.last_communication IS NULL THEN 'sem dados'
      WHEN now() - e.last_communication >= interval '15 minutes' THEN 'Offline'
      WHEN now() - e.last_communication >= interval '13 minutes' THEN 'Crítico'
      WHEN now() - e.last_communication >= interval '11 minutes' THEN 'Recuperação'
      WHEN now() - e.last_communication >= interval '8 minutes'  THEN 'Atenção'
      ELSE 'Normal' END,
    (SELECT count(*) FROM public.adaptive_telemetry_log l
      WHERE l.equipment_id = e.id AND l.outcome IN ('fail','timeout')
        AND l.occurred_at > now() - interval '24 hours'),
    (SELECT count(*) FROM public.adaptive_telemetry_log l
      WHERE l.equipment_id = e.id AND l.attempt_sent
        AND l.occurred_at > now() - interval '24 hours'),
    (SELECT ROUND(MAX(l.seconds_since_reply)/60.0, 1) FROM public.adaptive_telemetry_log l
      WHERE l.equipment_id = e.id AND l.occurred_at > now() - interval '24 hours'),
    e.adaptive_telemetry_updated_at,
    (SELECT p.full_name FROM public.profiles p WHERE p.id = e.adaptive_telemetry_updated_by)
  FROM public.equipments e
 WHERE e.farm_id = _farm_id AND e.active = true
   AND public.is_platform_staff(auth.uid())   -- cliente não lê este painel
 ORDER BY e.adaptive_telemetry_enabled DESC, e.name;
$$;
GRANT EXECUTE ON FUNCTION public.adaptive_telemetry_health(uuid) TO authenticated, service_role;

-- ============================================================================
-- CONFERÊNCIA
--   SELECT count(*) FROM public.equipments WHERE adaptive_telemetry_enabled; -- 0
--   -- localizar os dois poços do piloto (NÃO ativa nada):
--   SELECT e.id, e.name FROM public.equipments e JOIN public.farms f ON f.id=e.farm_id
--    WHERE f.name ILIKE '%sykue%' AND (e.name ILIKE '%02%' OR e.name ILIKE '%14%');
--   SELECT * FROM public.adaptive_telemetry_health('<farm sykue>');
-- ROLLBACK:
--   UPDATE public.equipments SET adaptive_telemetry_enabled = false;
--   -- toda a frota volta ao ciclo atual imediatamente.
-- ============================================================================
