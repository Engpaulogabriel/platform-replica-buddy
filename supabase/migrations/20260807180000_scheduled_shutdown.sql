-- Desligamento Programado (Fazenda Semear, 17h BRT) ─────────────────────────
-- Tabela de auditoria (estado da máquina + histórico) + agendamento pg_cron.
-- Ciclo (seg–sex): 17:00 tent.1 · 17:05 tent.2 · 17:10 tent.3 + AVISO 1 ·
-- 17:20 verificação final + AVISO 2 (só se ainda houver bomba ligada).
-- A edge function `scheduled-shutdown` é idempotente: indexa cada passo pelo
-- minuto BRT e o registra em steps_done, agindo uma única vez por passo.

-- 1) Tabela de auditoria / estado ------------------------------------------
CREATE TABLE IF NOT EXISTS public.scheduled_shutdowns (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id      uuid NOT NULL,
  run_date     date NOT NULL,                 -- data BRT do "run" do dia
  attempt      int  NOT NULL DEFAULT 0,       -- última tentativa executada (1..3)
  status       text NOT NULL DEFAULT 'running', -- running | done
  steps_done   jsonb NOT NULL DEFAULT '[]'::jsonb, -- passos já executados: ["a1","a2","a3","final"]
  last_attempt_at timestamptz,                -- horário da última tentativa
  targeted     jsonb,                         -- bombas comandadas na última tentativa
  remaining    jsonb,                         -- bombas que resistiram (17:10 / 17:20)
  alert1_sent  boolean NOT NULL DEFAULT false, -- AVISO 1 (17:10)
  alert2_sent  boolean NOT NULL DEFAULT false, -- AVISO 2 (17:20)
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (farm_id, run_date)
);

-- Colunas novas (idempotente, caso a tabela já exista de um deploy anterior).
ALTER TABLE public.scheduled_shutdowns ADD COLUMN IF NOT EXISTS steps_done  jsonb   NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.scheduled_shutdowns ADD COLUMN IF NOT EXISTS alert1_sent boolean NOT NULL DEFAULT false;
ALTER TABLE public.scheduled_shutdowns ADD COLUMN IF NOT EXISTS alert2_sent boolean NOT NULL DEFAULT false;

ALTER TABLE public.scheduled_shutdowns ENABLE ROW LEVEL SECURITY;

-- leitura para usuários autenticados (auditoria via plataforma); escrita só
-- pela service_role (edge function) — nenhuma policy de INSERT/UPDATE p/ authenticated.
DROP POLICY IF EXISTS scheduled_shutdowns_select ON public.scheduled_shutdowns;
CREATE POLICY scheduled_shutdowns_select ON public.scheduled_shutdowns
  FOR SELECT TO authenticated USING (true);

CREATE INDEX IF NOT EXISTS idx_scheduled_shutdowns_farm_date
  ON public.scheduled_shutdowns (farm_id, run_date DESC);

-- 2) Agendamento pg_cron ----------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Remove agendamento anterior (idempotência do deploy).
DO $$
BEGIN
  PERFORM cron.unschedule('scheduled-shutdown-semear-17h');
EXCEPTION WHEN OTHERS THEN
  NULL; -- não existia ainda
END $$;

-- Dispara 20:00–20:20 UTC (17:00–17:20 BRT), 1x/min, SEG–SEX (dow 1-5).
-- A hora 20 UTC cai no mesmo dia da semana que 17 BRT, então dow no cron = dow BRT.
SELECT cron.schedule(
  'scheduled-shutdown-semear-17h',
  '0-20 20 * * 1-5',
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
