-- ============================================================================
-- ANTI-IA / ANTI-SCRAPING — auditoria, rate-limit e limite de exportação.
-- ----------------------------------------------------------------------------
-- NOTA DE COBERTURA: leituras do Supabase vão DIRETO ao PostgREST (não passam por
-- edge functions). Estas tabelas/RPCs cobrem o que passa pela edge api-rate-limiter
-- (chamada pelo client em navegação/export) — NÃO é um gateway global. A contenção
-- de massa continua sendo a RLS por fazenda. Ver instruções de deploy.
-- Idempotente. Aplicar via push (Lovable) ou SQL Editor.
-- ============================================================================

-- ── 1) user_activity_log ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_activity_log (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid,
  session_id text,
  path       text,
  method     text,
  ip         text,
  user_agent text,
  flag       text,                 -- ex.: 'rate_limited', 'anomaly_alerted'
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ual_user_time   ON public.user_activity_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ual_time        ON public.user_activity_log (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ual_flag        ON public.user_activity_log (flag, created_at DESC) WHERE flag IS NOT NULL;

ALTER TABLE public.user_activity_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ual_insert_own ON public.user_activity_log;
CREATE POLICY ual_insert_own ON public.user_activity_log
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS ual_select_admin ON public.user_activity_log;
CREATE POLICY ual_select_admin ON public.user_activity_log
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid()));

-- ── 2) rate_limit_violations (também é o contador por janela) ────────────────
CREATE TABLE IF NOT EXISTS public.rate_limit_violations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  endpoint     text NOT NULL,          -- classe: 'api' | 'export'
  ip           text NOT NULL DEFAULT 'unknown',  -- device_id (localStorage) OU ip
  window_start timestamptz NOT NULL,   -- início do bucket (janela de 1 min)
  count        int NOT NULL DEFAULT 1,
  blocked_until timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);
-- Idempotente p/ instalações que já tinham a tabela SEM ip (rate por DISPOSITIVO:
-- vários operadores na mesma conta, cada device com seu limite).
ALTER TABLE public.rate_limit_violations ADD COLUMN IF NOT EXISTS ip text NOT NULL DEFAULT 'unknown';
ALTER TABLE public.rate_limit_violations DROP CONSTRAINT IF EXISTS rate_limit_violations_user_id_endpoint_window_start_key;
-- Chave única inclui o device (ip/device_id): (user_id, endpoint, ip, window_start).
CREATE UNIQUE INDEX IF NOT EXISTS rlv_key ON public.rate_limit_violations (user_id, endpoint, ip, window_start);
CREATE INDEX IF NOT EXISTS idx_rlv_user_window ON public.rate_limit_violations (user_id, ip, window_start DESC);
CREATE INDEX IF NOT EXISTS idx_rlv_blocked     ON public.rate_limit_violations (blocked_until) WHERE blocked_until IS NOT NULL;
-- RLS on, SEM policy → só service_role (a edge escreve via RPC SECURITY DEFINER).
ALTER TABLE public.rate_limit_violations ENABLE ROW LEVEL SECURITY;

-- ── 3) export_log ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.export_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid,
  export_type text NOT NULL,           -- 'pdf' | 'csv'
  file_name   text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_export_user_type_time ON public.export_log (user_id, export_type, created_at DESC);
ALTER TABLE public.export_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS export_insert_own ON public.export_log;
CREATE POLICY export_insert_own ON public.export_log
  FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
DROP POLICY IF EXISTS export_select_admin ON public.export_log;
CREATE POLICY export_select_admin ON public.export_log
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.user_id = auth.uid()));

-- ── 4) RPC: rate limit atômico POR DISPOSITIVO (user_id + ip/device) ─────────
-- Chave = (user_id, endpoint, ip, window). Vários operadores na MESMA conta, mas
-- em devices diferentes, têm limites INDEPENDENTES. O bloqueio também é por device
-- (bloquear um celular não derruba os outros da conta). Limites originais (300/30).
DROP FUNCTION IF EXISTS public.check_and_bump_rate_limit(uuid, text, int, int);
CREATE OR REPLACE FUNCTION public.check_and_bump_rate_limit(
  _user_id uuid, _endpoint text, _ip text, _limit int, _window_seconds int
) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_ip text := COALESCE(NULLIF(_ip, ''), 'unknown');
  v_window_start timestamptz;
  v_count int;
  v_blocked_until timestamptz;
  v_daily int;
BEGIN
  IF _user_id IS NULL THEN
    RETURN jsonb_build_object('allowed', true, 'reason', 'no_user');
  END IF;

  -- bloqueio ativo NESTE device?
  SELECT max(blocked_until) INTO v_blocked_until
    FROM rate_limit_violations
   WHERE user_id = _user_id AND ip = v_ip AND blocked_until IS NOT NULL AND blocked_until > now();
  IF v_blocked_until IS NOT NULL THEN
    RETURN jsonb_build_object('allowed', false, 'reason', 'blocked', 'blocked_until', v_blocked_until);
  END IF;

  -- bucket da janela (ex.: 60s)
  v_window_start := to_timestamp(floor(extract(epoch FROM now()) / _window_seconds) * _window_seconds);

  INSERT INTO rate_limit_violations (user_id, endpoint, ip, window_start, count)
  VALUES (_user_id, _endpoint, v_ip, v_window_start, 1)
  ON CONFLICT (user_id, endpoint, ip, window_start)
  DO UPDATE SET count = rate_limit_violations.count + 1
  RETURNING count INTO v_count;

  IF v_count <= _limit THEN
    RETURN jsonb_build_object('allowed', true, 'count', v_count, 'limit', _limit);
  END IF;

  -- excedeu: nº de janelas violadas hoje NESTE device (reincidência)
  SELECT count(*) INTO v_daily
    FROM rate_limit_violations
   WHERE user_id = _user_id AND endpoint = _endpoint AND ip = v_ip
     AND count > _limit AND window_start >= date_trunc('day', now());

  IF v_daily >= 3 THEN
    v_blocked_until := now() + interval '1 hour';
    UPDATE rate_limit_violations
       SET blocked_until = v_blocked_until
     WHERE user_id = _user_id AND endpoint = _endpoint AND ip = v_ip AND window_start = v_window_start;
  END IF;

  RETURN jsonb_build_object('allowed', false, 'count', v_count, 'limit', _limit,
    'daily_violations', v_daily, 'blocked_until', v_blocked_until);
END; $$;

-- ── 5) RPC: limite de exportação (login COMPARTILHADO; platform_admin ilimitado) ──
-- Base generosa p/ vários operadores numa MESMA conta: 30 PDFs/h e 100 CSVs/dia.
-- platform_admins: SEM limite. (Antes era 10/30 com 3x p/ admin — subimos a base e
-- liberamos o platform_admin de vez.)
CREATE OR REPLACE FUNCTION public.check_export_limit(_user_id uuid, _export_type text)
RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_limit int;
  v_window interval;
  v_used int;
BEGIN
  IF _user_id IS NULL THEN RETURN jsonb_build_object('allowed', true, 'reason', 'no_user'); END IF;

  -- platform_admin: sem limite nenhum.
  IF EXISTS (SELECT 1 FROM platform_admins pa WHERE pa.user_id = _user_id) THEN
    RETURN jsonb_build_object('allowed', true, 'unlimited', true, 'admin', true);
  END IF;

  IF lower(_export_type) = 'pdf' THEN v_limit := 30;  v_window := interval '1 hour';
  ELSE                                v_limit := 100; v_window := interval '1 day';
  END IF;

  SELECT count(*) INTO v_used FROM export_log
   WHERE user_id = _user_id AND lower(export_type) = lower(_export_type)
     AND created_at >= now() - v_window;

  RETURN jsonb_build_object('allowed', v_used < v_limit, 'used', v_used, 'limit', v_limit);
END; $$;

GRANT EXECUTE ON FUNCTION public.check_and_bump_rate_limit(uuid, text, text, int, int) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.check_export_limit(uuid, text) TO authenticated, service_role;

-- ── 6) Housekeeping opcional: limpar logs antigos (agende via pg_cron se quiser)
-- DELETE FROM public.user_activity_log  WHERE created_at < now() - interval '90 days';
-- DELETE FROM public.rate_limit_violations WHERE window_start < now() - interval '7 days';
