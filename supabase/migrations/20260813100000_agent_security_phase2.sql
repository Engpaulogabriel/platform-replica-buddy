-- ============================================================================
-- FASE 2 da segurança do agente — flag por fazenda + trilha de eventos.
-- ----------------------------------------------------------------------------
-- ENFORCEMENT OFF: nada aqui bloqueia o agente. A FASE 2 (token rotativo, DPAPI,
-- fingerprint) só ATIVA quando farms.security_phase >= 2; para as demais fazendas
-- o agente segue exatamente como hoje (anon + config). Testar só na Sykue.
-- Idempotente. Aplicar via push (Lovable) ou SQL Editor.
-- ============================================================================

-- 1) Flag de fase de segurança por fazenda (0 = desligado; 2 = FASE 2 ativa).
ALTER TABLE public.farms
  ADD COLUMN IF NOT EXISTS security_phase int NOT NULL DEFAULT 0;

-- 2) Trilha de eventos de segurança (append-only). O agente grava token_expired/
--    dpapi_failed; a edge agent-auth grava fingerprint_mismatch/clone_detected.
CREATE TABLE IF NOT EXISTS public.agent_security_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id       uuid REFERENCES public.farms(id) ON DELETE CASCADE,
  event_type    text NOT NULL,   -- token_expired | dpapi_failed | fingerprint_mismatch | clone_detected
  details       jsonb NOT NULL DEFAULT '{}'::jsonb,
  agent_version text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_security_events_farm_time
  ON public.agent_security_events (farm_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_security_events_type
  ON public.agent_security_events (event_type, created_at DESC);

ALTER TABLE public.agent_security_events ENABLE ROW LEVEL SECURITY;

-- LEITURA: quem tem acesso à fazenda (dashboard de segurança / platform_admin).
DROP POLICY IF EXISTS agent_security_events_select ON public.agent_security_events;
CREATE POLICY agent_security_events_select ON public.agent_security_events
  FOR SELECT TO authenticated USING (public.has_farm_access(auth.uid(), farm_id));

-- ESCRITA: o agente (sessão do operador) grava eventos da própria fazenda.
-- A edge agent-auth usa service_role (ignora RLS).
DROP POLICY IF EXISTS agent_security_events_insert ON public.agent_security_events;
CREATE POLICY agent_security_events_insert ON public.agent_security_events
  FOR INSERT TO authenticated WITH CHECK (public.can_write_farm(auth.uid(), farm_id));

-- 3) Ativar FASE 2 APENAS na Sykue (as demais permanecem em 0).
UPDATE public.farms
   SET security_phase = 2
 WHERE name ILIKE '%sykue%'
   AND security_phase < 2;
