-- Automações Programadas (config-driven) ────────────────────────────────────
-- Substitui o desligamento hardcoded por regras EDITÁVEIS na plataforma web
-- (aba "Automações"). A edge function `scheduled-shutdown` passa a ler estas
-- regras a cada minuto e executa a que casar com o horário/dia atual (BRT).

-- 1) Tabela de regras -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.scheduled_automations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id               uuid NOT NULL,
  name                  text NOT NULL,
  action                text NOT NULL DEFAULT 'shutdown_all'
                          CHECK (action IN ('shutdown_all', 'shutdown_specific')),
  time_brt              text NOT NULL CHECK (time_brt ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'), -- HH:MM
  days_of_week          text[] NOT NULL DEFAULT ARRAY['mon','tue','wed','thu','fri'],       -- mon..sun
  excluded_equipment_ids uuid[] NOT NULL DEFAULT '{}',  -- shutdown_all: bombas a NÃO desligar
  target_equipment_ids  uuid[] NOT NULL DEFAULT '{}',   -- shutdown_specific: desligar APENAS estas
  retry_interval_min    int  NOT NULL DEFAULT 5  CHECK (retry_interval_min BETWEEN 1 AND 60),
  max_retries           int  NOT NULL DEFAULT 3  CHECK (max_retries BETWEEN 1 AND 10),
  alert_after_retries   boolean NOT NULL DEFAULT true,
  is_active             boolean NOT NULL DEFAULT true,
  last_run_at           timestamptz,
  last_run_result       jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (farm_id, name)
);

ALTER TABLE public.scheduled_automations ENABLE ROW LEVEL SECURITY;

-- CRUD só para quem pode escrever na fazenda (can_write_farm cobre platform_admin).
DROP POLICY IF EXISTS scheduled_automations_select ON public.scheduled_automations;
CREATE POLICY scheduled_automations_select ON public.scheduled_automations
  FOR SELECT TO authenticated USING (public.can_write_farm(auth.uid(), farm_id));
DROP POLICY IF EXISTS scheduled_automations_insert ON public.scheduled_automations;
CREATE POLICY scheduled_automations_insert ON public.scheduled_automations
  FOR INSERT TO authenticated WITH CHECK (public.can_write_farm(auth.uid(), farm_id));
DROP POLICY IF EXISTS scheduled_automations_update ON public.scheduled_automations;
CREATE POLICY scheduled_automations_update ON public.scheduled_automations
  FOR UPDATE TO authenticated USING (public.can_write_farm(auth.uid(), farm_id))
  WITH CHECK (public.can_write_farm(auth.uid(), farm_id));
DROP POLICY IF EXISTS scheduled_automations_delete ON public.scheduled_automations;
CREATE POLICY scheduled_automations_delete ON public.scheduled_automations
  FOR DELETE TO authenticated USING (public.can_write_farm(auth.uid(), farm_id));

CREATE INDEX IF NOT EXISTS idx_scheduled_automations_active
  ON public.scheduled_automations (is_active) WHERE is_active;

-- 2) Tabela de estado/auditoria por execução --------------------------------
-- (idempotência da máquina de estados: 1 linha por automação/dia BRT)
CREATE TABLE IF NOT EXISTS public.scheduled_shutdowns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id      uuid NOT NULL,
  run_date     date NOT NULL,
  attempt      int  NOT NULL DEFAULT 0,
  status       text NOT NULL DEFAULT 'running',
  steps_done   jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_attempt_at timestamptz,
  targeted     jsonb,
  remaining    jsonb,
  alert1_sent  boolean NOT NULL DEFAULT false,
  alert2_sent  boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
-- vincula ao registro da automação (nova coluna; idempotente)
ALTER TABLE public.scheduled_shutdowns ADD COLUMN IF NOT EXISTS automation_id uuid;
ALTER TABLE public.scheduled_shutdowns ADD COLUMN IF NOT EXISTS steps_done  jsonb   NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.scheduled_shutdowns ADD COLUMN IF NOT EXISTS alert1_sent boolean NOT NULL DEFAULT false;
ALTER TABLE public.scheduled_shutdowns ADD COLUMN IF NOT EXISTS alert2_sent boolean NOT NULL DEFAULT false;

-- troca a chave de unicidade: agora é por automação/dia (não mais por fazenda/dia)
ALTER TABLE public.scheduled_shutdowns DROP CONSTRAINT IF EXISTS scheduled_shutdowns_farm_id_run_date_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_scheduled_shutdowns_automation_date
  ON public.scheduled_shutdowns (automation_id, run_date);

ALTER TABLE public.scheduled_shutdowns ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS scheduled_shutdowns_select ON public.scheduled_shutdowns;
CREATE POLICY scheduled_shutdowns_select ON public.scheduled_shutdowns
  FOR SELECT TO authenticated USING (public.can_write_farm(auth.uid(), farm_id));

CREATE INDEX IF NOT EXISTS idx_scheduled_shutdowns_farm_date
  ON public.scheduled_shutdowns (farm_id, run_date DESC);

-- 3) Seed: Desligamento 17h Semear (seg–sex) --------------------------------
INSERT INTO public.scheduled_automations
  (farm_id, name, action, time_brt, days_of_week, excluded_equipment_ids,
   retry_interval_min, max_retries, alert_after_retries, is_active)
VALUES
  ('0b1d53df-6d5c-4674-8517-9299aac3ec18', 'Desligamento 17h Semear', 'shutdown_all',
   '17:00', ARRAY['mon','tue','wed','thu','fri'], '{}', 5, 3, true, true)
ON CONFLICT (farm_id, name) DO NOTHING;

-- 4) pg_cron: 1x/min. A função é idempotente e só age no minuto certo de cada regra.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

DO $$
BEGIN
  PERFORM cron.unschedule('scheduled-shutdown-semear-17h'); -- remove o cron hardcoded antigo
EXCEPTION WHEN OTHERS THEN NULL;
END $$;
DO $$
BEGIN
  PERFORM cron.unschedule('scheduled-automations-tick');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'scheduled-automations-tick',
  '* * * * *',
  $cron$
  SELECT net.http_post(
    url     := 'https://dnyukgfedredvxpzjpqz.supabase.co/functions/v1/scheduled-shutdown',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRueXVrZ2ZlZHJlZHZ4cHpqcHF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2ODU1OTQsImV4cCI6MjA5MjI2MTU5NH0.OSg44w0CRVvD-f6Ts_U9DVeQkQ-4c37passKEK5X0kk',
      'apikey',        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRueXVrZ2ZlZHJlZHZ4cHpqcHF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2ODU1OTQsImV4cCI6MjA5MjI2MTU5NH0.OSg44w0CRVvD-f6Ts_U9DVeQkQ-4c37passKEK5X0kk',
      'Content-Type',  'application/json'
    ),
    body := jsonb_build_object('source','pg_cron','ts', now())
  );
  $cron$
);
