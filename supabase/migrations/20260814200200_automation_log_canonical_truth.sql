-- ============================================================================
-- automation_log = HISTÓRICO OFICIAL. Nada de lixo gravado para esconder depois.
-- ----------------------------------------------------------------------------
-- Corrige a regressão dos COMANDOS REMOTOS sumidos e estabelece o princípio
-- definitivo do Relatório de Automação. Forward-only: as migrations
-- 20260814200000 e 20260814200100 já estão aplicadas em produção e NÃO são
-- reescritas — esta as sucede e compensa o que elas esconderam.
--
-- ── POR QUE O REMOTO SUMIU ────────────────────────────────────────────────────
-- Uma atuação remota gera DUAS linhas, e a que confirma o estado chega primeiro:
--   (b) apply_pump_telemetry  → confirma o estado físico. origin=remote|local|
--       system, result='success', SEM user_id. Chega primeiro.
--   (c) trg_log_manual_command → identifica o USUÁRIO. origin='remote',
--       user_id=created_by, result='success' só se o comando já estava
--       'executed' OU o estado real já batia. Chega depois.
-- Defeito 1 (introduzido em 20260814200000): (c) com result='fail' era rebaixado
--   a status_read → invisível. Antes era exibido como "Ligada · Remoto · Falhou".
-- Defeito 2 (pré-existente, exposto pela limpeza): (b) consome a transição e (c)
--   é descartado como repetição → sobra a linha sem usuário, com origin 'local'
--   (ramo v_state_changed de apply_pump_telemetry) ou 'system' (filtrada no
--   frontend) → "o histórico mostra só Local/Sistema".
--
-- ── PRINCÍPIO ────────────────────────────────────────────────────────────────
-- 1. O porteiro da transição é a MUDANÇA DE ESTADO FÍSICO, nunca `result`.
--    `result` é metadado de atribuição, medido antes de a telemetria chegar.
-- 2. Uma transição = UMA linha, com a MELHOR atribuição disponível. Quem chega
--    depois com evidência mais forte faz UPGRADE da linha, não cria outra.
-- 3. O que não é evento operacional NÃO é gravado — é DESCARTADO. Nada de
--    persistir polling como status_read (também é lixo, e cresce o banco).
-- 4. Só exceções úteis ao diagnóstico vão para histórico técnico SEPARADO, com
--    retenção curta.
-- 5. Rotina periódica de integridade como rede de segurança.
--
-- Não toca relé, bridge, agente, FASE 2, licença, OTA nem segurança. Idempotente.
-- ============================================================================

-- ── 1) HISTÓRICO TÉCNICO SEPARADO (retenção curta) ──────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_technical_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id        uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  equipment_id   uuid,
  equipment_name text,
  kind           text NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  details        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_technical_events_kind_chk CHECK (kind IN (
    'command_timeout',        -- comando estourou a janela
    'command_not_confirmed',  -- tentativa que não confirmou o estado
    'bridge_error',           -- erro de bridge/serial
    'comm_lost',              -- perda de comunicação
    'comm_restored',          -- retorno de comunicação
    'state_conflict',         -- estado esperado ≠ confirmado
    'noise_threshold'         -- ruído recorrente acima do limite (alerta)
  ))
);
CREATE INDEX IF NOT EXISTS idx_ate_farm_time ON public.agent_technical_events (farm_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ate_kind_time ON public.agent_technical_events (kind, occurred_at DESC);

ALTER TABLE public.agent_technical_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ate_select ON public.agent_technical_events;
CREATE POLICY ate_select ON public.agent_technical_events
  FOR SELECT TO authenticated USING (public.has_farm_access(auth.uid(), farm_id));
-- escrita só por trigger/rotina (SECURITY DEFINER). Sem policy de INSERT.

COMMENT ON TABLE public.agent_technical_events IS
  'Diagnóstico técnico com retenção de 30 dias. NÃO é histórico operacional — nunca entra no Relatório de Automação, CSV ou PDF.';

-- ── 2) CONTADOR DE RUÍDO por fazenda/equipamento/dia ────────────────────────
CREATE TABLE IF NOT EXISTS public.automation_log_noise_stats (
  farm_id      uuid NOT NULL,
  equipment_id uuid,
  day          date NOT NULL,
  reason       text NOT NULL,
  hits         int  NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (farm_id, equipment_id, day, reason)
);
ALTER TABLE public.automation_log_noise_stats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS alns_select ON public.automation_log_noise_stats;
CREATE POLICY alns_select ON public.automation_log_noise_stats
  FOR SELECT TO authenticated USING (public.has_farm_access(auth.uid(), farm_id));

CREATE OR REPLACE FUNCTION public.bump_automation_noise(_farm uuid, _equip uuid, _reason text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.automation_log_noise_stats (farm_id, equipment_id, day, reason, hits)
  VALUES (_farm, _equip, current_date, _reason, 1)
  ON CONFLICT (farm_id, equipment_id, day, reason)
  DO UPDATE SET hits = public.automation_log_noise_stats.hits + 1, updated_at = now();
$$;

-- ── 3) RANK DE ATRIBUIÇÃO ───────────────────────────────────────────────────
-- Quem tem a evidência mais forte sobre QUEM causou a transição.
--   4 remoto/WhatsApp com usuário identificado · 3 automação · 2 local (TX
--   espontâneo) · 1 telemetria/sistema/leitura (sem autoria).
CREATE OR REPLACE FUNCTION public.automation_attribution_rank(
  _origin public.event_origin, _user_id uuid, _source_device text, _actor text)
RETURNS int LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN _origin = 'remote'::public.event_origin
         AND (_user_id IS NOT NULL OR lower(COALESCE(_source_device,'')) LIKE 'whatsapp:%') THEN 4
    WHEN _origin = 'auto'::public.event_origin AND COALESCE(_actor,'') <> '' THEN 3
    WHEN _origin = 'auto'::public.event_origin THEN 3
    WHEN _origin = 'local'::public.event_origin THEN 2
    ELSE 1
  END;
$$;

-- ── 4) A GUARDA ÚNICA ───────────────────────────────────────────────────────
-- Dispara por último entre os BEFORE INSERT de automation_log (ordem alfabética).
CREATE OR REPLACE FUNCTION public.enforce_automation_log_state_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_state SMALLINT;
  v_last_state SMALLINT;
  v_prev RECORD;
  v_rank_new int;
  v_rank_prev int;
  v_tipo text;
  v_confirmed boolean;
BEGIN
  -- ── 4.1 Ações que não afirmam estado ──────────────────────────────────────
  IF NEW.action NOT IN ('turn_on','turn_off','pump_on','pump_off') THEN
    v_tipo := COALESCE(NEW.details->>'tipo_evento', NEW.details->>'kind', '');

    -- Perda/retorno de comunicação são exceções ÚTEIS → histórico técnico.
    IF v_tipo IN ('equipamento_offline','equipamento_online') THEN
      INSERT INTO public.agent_technical_events (farm_id, equipment_id, equipment_name, kind, occurred_at, details)
      VALUES (NEW.farm_id, NEW.equipment_id, NEW.equipment_name,
              CASE WHEN v_tipo = 'equipamento_offline' THEN 'comm_lost' ELSE 'comm_restored' END,
              NEW.occurred_at, COALESCE(NEW.details, '{}'::jsonb));
      RETURN NULL;   -- NÃO polui o histórico oficial
    END IF;

    -- Polling e leitura de status: lixo puro. DESCARTA (nem status_read fica).
    IF NEW.action IN ('status_read','polling') THEN
      PERFORM public.bump_automation_noise(NEW.farm_id, NEW.equipment_id, 'discarded_reading');
      RETURN NULL;
    END IF;

    RETURN NEW;   -- mode_change / reset seguem como auditoria
  END IF;

  -- ── 4.2 Linhas de estado que nunca são transição ──────────────────────────
  IF NEW.equipment_id IS NULL THEN
    PERFORM public.bump_automation_noise(NEW.farm_id, NULL, 'no_equipment');
    RETURN NULL;
  END IF;

  -- Observação de telemetria (polling/eco/reconexão/startup) — DESCARTA.
  IF NEW.origin = 'reading'::public.event_origin THEN
    PERFORM public.bump_automation_noise(NEW.farm_id, NEW.equipment_id, 'reading_origin');
    RETURN NULL;
  END IF;

  v_new_state := CASE WHEN NEW.action IN ('turn_on','pump_on') THEN 1 ELSE 0 END;

  -- CONFIRMAÇÃO FÍSICA: `result='success'` já significa "executou OU o estado real
  -- bate com a intenção" (log_manual_command_to_automation_log, 20260811350000).
  -- `details.state_confirmed` é a mesma prova, explícita. Sem uma das duas, não há
  -- evidência de que a bomba mudou — e o log oficial não pode fingir que mudou.
  v_confirmed := (NEW.result = 'success'::public.event_result)
              OR (NEW.details->>'state_confirmed' = 'true');

  SELECT last_confirmed_state INTO v_last_state
    FROM public.equipments WHERE id = NEW.equipment_id FOR UPDATE;

  -- ── 4.3 MUDANÇA DE ESTADO CONFIRMADA = transição oficial ──────────────────
  IF (v_last_state IS NULL OR v_last_state <> v_new_state) AND v_confirmed THEN
    UPDATE public.equipments SET last_confirmed_state = v_new_state WHERE id = NEW.equipment_id;
    NEW.noise_reason := NULL;
    RETURN NEW;
  END IF;

  -- ── 4.3b Mudaria o estado, mas NADA confirma → falha operacional ──────────
  -- Vai para o histórico técnico ligada ao comando, sem fingir que mudou estado.
  IF (v_last_state IS NULL OR v_last_state <> v_new_state) AND NOT v_confirmed THEN
    INSERT INTO public.agent_technical_events (farm_id, equipment_id, equipment_name, kind, occurred_at, details)
    VALUES (NEW.farm_id, NEW.equipment_id, NEW.equipment_name,
            CASE WHEN NEW.result = 'timeout'::public.event_result THEN 'command_timeout'
                 ELSE 'command_not_confirmed' END,
            NEW.occurred_at,
            COALESCE(NEW.details, '{}'::jsonb) || jsonb_build_object(
              'intended_action', NEW.action::text, 'origin', NEW.origin::text,
              'user_id', NEW.user_id, 'actor_label', NEW.actor_label,
              'last_confirmed_state', v_last_state));
    RETURN NULL;
  END IF;

  -- ── 4.4 Estado repetido: pode ser UPGRADE DE ATRIBUIÇÃO ───────────────────
  -- A linha que confirmou o estado chegou sem autoria; esta traz o usuário.
  -- Em vez de descartar (e perder o "Remoto + usuário") ou duplicar, promove
  -- a linha existente. Uma transição continua sendo UMA linha.
  -- Janela por PROXIMIDADE DE EVENTO (não em relação a now()): as duas linhas
  -- descrevem a MESMA transição física, então seus occurred_at são vizinhos —
  -- mesmo quando a telemetria chega atrasada e o log é gravado com atraso.
  -- O limite de `created_at` impede que um backfill promova história antiga.
  SELECT id, origin, user_id, source_device, actor_label
    INTO v_prev
    FROM public.automation_log
   WHERE equipment_id = NEW.equipment_id
     AND noise_reason IS NULL
     AND action IN ('turn_on','turn_off','pump_on','pump_off')
     AND (CASE WHEN action IN ('turn_on','pump_on') THEN 1 ELSE 0 END) = v_new_state
     AND occurred_at BETWEEN NEW.occurred_at - interval '180 seconds'
                         AND NEW.occurred_at + interval '180 seconds'
     AND created_at > now() - interval '15 minutes'
   ORDER BY occurred_at DESC, created_at DESC
   LIMIT 1;

  IF FOUND THEN
    v_rank_new  := public.automation_attribution_rank(NEW.origin, NEW.user_id, NEW.source_device, NEW.actor_label);
    v_rank_prev := public.automation_attribution_rank(v_prev.origin, v_prev.user_id, v_prev.source_device, v_prev.actor_label);

    IF v_rank_new > v_rank_prev THEN
      UPDATE public.automation_log
         SET origin        = NEW.origin,
             user_id       = COALESCE(NEW.user_id, user_id),
             user_email    = COALESCE(NEW.user_email, user_email),
             actor_label   = COALESCE(NEW.actor_label, actor_label),
             source_device = COALESCE(NEW.source_device, source_device),
             details       = COALESCE(details, '{}'::jsonb)
                             || jsonb_build_object('attribution_upgraded_from', v_prev.origin::text,
                                                   'attribution_rank', v_rank_new)
       WHERE id = v_prev.id;
      RETURN NULL;   -- promoveu a existente; não cria segunda linha
    END IF;
  END IF;

  -- ── 4.5 Tentativa de comando que NÃO confirmou → histórico técnico ────────
  IF NEW.result IS DISTINCT FROM 'success'::public.event_result
     AND (NEW.user_id IS NOT NULL OR (NEW.details ? 'command_id')) THEN
    INSERT INTO public.agent_technical_events (farm_id, equipment_id, equipment_name, kind, occurred_at, details)
    VALUES (NEW.farm_id, NEW.equipment_id, NEW.equipment_name,
            CASE WHEN NEW.result = 'timeout'::public.event_result THEN 'command_timeout'
                 ELSE 'command_not_confirmed' END,
            NEW.occurred_at,
            COALESCE(NEW.details, '{}'::jsonb) || jsonb_build_object(
              'intended_action', NEW.action::text, 'origin', NEW.origin::text,
              'user_id', NEW.user_id, 'actor_label', NEW.actor_label));
    RETURN NULL;   -- registra a falha SEM fingir que mudou estado
  END IF;

  -- ── 4.6 Resto: repetição pura (ON→ON / OFF→OFF, eco, retry) → DESCARTA ────
  PERFORM public.bump_automation_noise(NEW.farm_id, NEW.equipment_id, 'repeated_state');
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_automation_log_state_change ON public.automation_log;
CREATE TRIGGER trg_enforce_automation_log_state_change
BEFORE INSERT ON public.automation_log
FOR EACH ROW
EXECUTE FUNCTION public.enforce_automation_log_state_change();

-- ── 5) ROTINA DE INTEGRIDADE (rede de segurança) ────────────────────────────
-- Marca o que escapou, conta o ruído e abre alerta técnico se for recorrente.
-- NUNCA apaga dado oficial.
CREATE OR REPLACE FUNCTION public.audit_automation_log_integrity(
  _lookback interval DEFAULT interval '48 hours',
  _threshold int DEFAULT 20)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_marked int := 0; v_n int; r record;
BEGIN
  -- 5.1 linhas oficiais que violam o cânone
  UPDATE public.automation_log
     SET noise_reason = CASE WHEN equipment_id IS NULL THEN 'no_equipment' ELSE 'reading_origin' END
   WHERE occurred_at > now() - _lookback
     AND noise_reason IS NULL
     AND action IN ('turn_on','turn_off','pump_on','pump_off')
     AND (equipment_id IS NULL OR origin = 'reading'::public.event_origin);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_marked := v_marked + v_n;

  -- 5.2 estados repetidos consecutivos que escaparam
  WITH ordered AS (
    SELECT id, equipment_id,
           CASE WHEN action IN ('turn_on','pump_on') THEN 1 ELSE 0 END AS st,
           lag(CASE WHEN action IN ('turn_on','pump_on') THEN 1 ELSE 0 END)
             OVER (PARTITION BY equipment_id ORDER BY occurred_at, created_at, id) AS prev_st
      FROM public.automation_log
     WHERE occurred_at > now() - _lookback
       AND noise_reason IS NULL
       AND action IN ('turn_on','turn_off','pump_on','pump_off')
       AND equipment_id IS NOT NULL
  )
  UPDATE public.automation_log al
     SET noise_reason = 'repeated_state'
    FROM ordered o
   WHERE al.id = o.id AND o.prev_st IS NOT NULL AND o.st = o.prev_st;
  GET DIAGNOSTICS v_n = ROW_COUNT; v_marked := v_marked + v_n;

  -- 5.3 contadores
  INSERT INTO public.automation_log_noise_stats (farm_id, equipment_id, day, reason, hits)
  SELECT farm_id, equipment_id, occurred_at::date, noise_reason, count(*)::int
    FROM public.automation_log
   WHERE occurred_at > now() - _lookback AND noise_reason IS NOT NULL
   GROUP BY farm_id, equipment_id, occurred_at::date, noise_reason
  ON CONFLICT (farm_id, equipment_id, day, reason)
  DO UPDATE SET hits = EXCLUDED.hits, updated_at = now();

  -- 5.4 alerta técnico quando o ruído é recorrente
  FOR r IN
    SELECT farm_id, equipment_id, sum(hits)::int AS total
      FROM public.automation_log_noise_stats
     WHERE day >= current_date - 1
     GROUP BY farm_id, equipment_id
    HAVING sum(hits) >= _threshold
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM public.agent_technical_events
       WHERE farm_id = r.farm_id AND kind = 'noise_threshold'
         AND equipment_id IS NOT DISTINCT FROM r.equipment_id
         AND occurred_at > now() - interval '12 hours')
    THEN
      INSERT INTO public.agent_technical_events (farm_id, equipment_id, kind, details)
      VALUES (r.farm_id, r.equipment_id, 'noise_threshold',
              jsonb_build_object('hits_48h', r.total, 'threshold', _threshold,
                                 'hint', 'ruído recorrente em automation_log — investigar a fonte'));
    END IF;
  END LOOP;

  RETURN v_marked;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_automation_log_integrity(interval, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.audit_automation_log_integrity(interval, int) TO service_role;

-- ── 6) RETENÇÃO do histórico técnico (30 dias) ──────────────────────────────
CREATE OR REPLACE FUNCTION public.purge_agent_technical_events(_keep interval DEFAULT interval '30 days')
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n int;
BEGIN
  DELETE FROM public.agent_technical_events WHERE occurred_at < now() - _keep;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  DELETE FROM public.automation_log_noise_stats WHERE day < current_date - 90;
  RETURN v_n;
END; $$;

-- Agendamento tolerante: as FUNÇÕES acima são o que importa e existem sempre.
-- Se pg_cron não estiver disponível (ambiente de teste/local), a migration segue
-- e só avisa — em vez de abortar tudo por causa do agendador.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron;
  BEGIN PERFORM cron.unschedule('automation-log-integrity'); EXCEPTION WHEN OTHERS THEN NULL; END;
  BEGIN PERFORM cron.unschedule('agent-technical-purge');    EXCEPTION WHEN OTHERS THEN NULL; END;
  PERFORM cron.schedule('automation-log-integrity', '*/15 * * * *',
    $cron$ SELECT public.audit_automation_log_integrity(); $cron$);
  PERFORM cron.schedule('agent-technical-purge', '17 3 * * *',
    $cron$ SELECT public.purge_agent_technical_events(); $cron$);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron indisponível (%) — agende manualmente audit_automation_log_integrity() a cada 15 min e purge_agent_technical_events() diariamente.', SQLERRM;
END $$;

-- ── 7) COMPENSAÇÃO do que 20260814200000/100 esconderam ─────────────────────
-- 7.1 Comandos remotos rebaixados a status_read por result<>'success'. A ação
--     original é recuperável pelo frame gravado em details (trg_log_manual_command).
UPDATE public.automation_log
   SET action = CASE
         WHEN details->>'frame' ~ '\{0*1\}' THEN 'turn_on'::public.event_action
         ELSE 'turn_off'::public.event_action END,
       noise_reason = NULL
 WHERE action = 'status_read'::public.event_action
   AND noise_reason = 'not_confirmed'
   AND details ? 'frame';

-- 7.2 Linhas de leitura que a versão anterior persistiu como status_read: são
--     polling puro (regra 3 — não devem existir). Remove só o que ELA criou.
DELETE FROM public.automation_log
 WHERE action = 'status_read'::public.event_action
   AND noise_reason = 'reading_origin';

-- 7.3 Reaplica o cânone sobre a janela recompensada e reconcilia o estado.
SELECT public.audit_automation_log_integrity(interval '30 days');

WITH last_ok AS (
  SELECT DISTINCT ON (equipment_id) equipment_id, action
    FROM public.automation_log
   WHERE equipment_id IS NOT NULL AND noise_reason IS NULL
     AND action IN ('turn_on','turn_off','pump_on','pump_off')
   ORDER BY equipment_id, occurred_at DESC, created_at DESC, id DESC
)
UPDATE public.equipments e
   SET last_confirmed_state = CASE WHEN last_ok.action IN ('turn_on','pump_on') THEN 1 ELSE 0 END
  FROM last_ok WHERE e.id = last_ok.equipment_id;

-- ============================================================================
-- CONFERÊNCIA (rodar depois):
--   SELECT origin, count(*) FROM public.automation_log
--    WHERE farm_id='<uuid>' AND occurred_at::date='2026-08-14' AND noise_reason IS NULL
--    GROUP BY origin;              -- deve mostrar 'remote' de volta
--   SELECT * FROM public.automation_log_noise_stats ORDER BY hits DESC LIMIT 20;
--   SELECT kind, count(*) FROM public.agent_technical_events GROUP BY kind;
-- ROLLBACK: UPDATE public.automation_log SET noise_reason = NULL; (nada oficial foi apagado)
-- ============================================================================
