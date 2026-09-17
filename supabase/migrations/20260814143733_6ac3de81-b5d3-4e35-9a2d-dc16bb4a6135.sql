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
    'command_timeout',
    'command_not_confirmed',
    'bridge_error',
    'comm_lost',
    'comm_restored',
    'state_conflict',
    'noise_threshold'
  ))
);
CREATE INDEX IF NOT EXISTS idx_ate_farm_time ON public.agent_technical_events (farm_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ate_kind_time ON public.agent_technical_events (kind, occurred_at DESC);

GRANT SELECT ON public.agent_technical_events TO authenticated;
GRANT ALL ON public.agent_technical_events TO service_role;

ALTER TABLE public.agent_technical_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ate_select ON public.agent_technical_events;
CREATE POLICY ate_select ON public.agent_technical_events
  FOR SELECT TO authenticated USING (public.has_farm_access(auth.uid(), farm_id));

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
GRANT SELECT ON public.automation_log_noise_stats TO authenticated;
GRANT ALL ON public.automation_log_noise_stats TO service_role;
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

-- ── 3.0) RÓTULO TÉCNICO ≠ ATOR HUMANO ───────────────────────────────────────
CREATE OR REPLACE FUNCTION public.is_technical_actor_label(_label text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT lower(btrim(COALESCE(_label,''))) ~
         '^(telemetria|telemetria rf|rf|agent|agente|serial|serial-bridge|bridge|system|sistema|cloud|auto-trigger)([ -].*)?$';
$$;

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
  v_prev_decl text;
  v_local_claim boolean;
  v_evidence boolean;
BEGIN
  IF NEW.action NOT IN ('turn_on','turn_off','pump_on','pump_off') THEN
    v_tipo := COALESCE(NEW.details->>'tipo_evento', NEW.details->>'kind', '');

    IF v_tipo IN ('equipamento_offline','equipamento_online') THEN
      INSERT INTO public.agent_technical_events (farm_id, equipment_id, equipment_name, kind, occurred_at, details)
      VALUES (NEW.farm_id, NEW.equipment_id, NEW.equipment_name,
              CASE WHEN v_tipo = 'equipamento_offline' THEN 'comm_lost' ELSE 'comm_restored' END,
              NEW.occurred_at, COALESCE(NEW.details, '{}'::jsonb));
      RETURN NULL;
    END IF;

    IF NEW.action IN ('status_read','polling') THEN
      PERFORM public.bump_automation_noise(NEW.farm_id, NEW.equipment_id, 'discarded_reading');
      RETURN NULL;
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.equipment_id IS NULL THEN
    PERFORM public.bump_automation_noise(NEW.farm_id, NULL, 'no_equipment');
    RETURN NULL;
  END IF;

  IF NEW.origin = 'reading'::public.event_origin THEN
    PERFORM public.bump_automation_noise(NEW.farm_id, NEW.equipment_id, 'reading_origin');
    RETURN NULL;
  END IF;

  v_new_state := CASE WHEN NEW.action IN ('turn_on','pump_on') THEN 1 ELSE 0 END;

  v_confirmed := (NEW.result = 'success'::public.event_result)
              OR (NEW.details->>'state_confirmed' = 'true');

  SELECT last_confirmed_state INTO v_last_state
    FROM public.equipments WHERE id = NEW.equipment_id FOR UPDATE;

  IF (v_last_state IS NULL OR v_last_state <> v_new_state) AND v_confirmed THEN
    UPDATE public.equipments SET last_confirmed_state = v_new_state WHERE id = NEW.equipment_id;
    NEW.noise_reason := NULL;

    IF public.automation_attribution_rank(NEW.origin, NEW.user_id, NEW.source_device, NEW.actor_label) = 1 THEN
      INSERT INTO public.agent_technical_events (farm_id, equipment_id, equipment_name, kind, occurred_at, details)
      VALUES (NEW.farm_id, NEW.equipment_id, NEW.equipment_name, 'state_conflict', NEW.occurred_at,
              COALESCE(NEW.details, '{}'::jsonb) || jsonb_build_object(
                'reason', 'transicao_confirmada_sem_atribuicao',
                'action', NEW.action::text, 'origin', NEW.origin::text,
                'note', 'Origem em apuração — transição física confirmada sem evidência de comando, automação ou TX local'));
    END IF;

    RETURN NEW;
  END IF;

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

  SELECT id, origin, user_id, source_device, actor_label, client_event_id, details
    INTO v_prev
    FROM public.automation_log
   WHERE farm_id = NEW.farm_id
     AND equipment_id = NEW.equipment_id
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

    v_prev_decl := lower(COALESCE(v_prev.details->>'origin', ''));

    v_local_claim := (v_prev_decl = 'local');

    v_evidence :=
         ( (NEW.details ? 'command_id')
           AND v_prev.details->>'command_id' = NEW.details->>'command_id' )
      OR ( NEW.client_event_id IS NOT NULL
           AND v_prev.client_event_id = NEW.client_event_id )
      OR v_prev_decl IN ('remote','remote-cmd','remote-desired','remote_cmd','remote_desired','auto')
      OR v_prev.origin IN ('remote'::public.event_origin, 'auto'::public.event_origin);

    IF (NEW.details ? 'command_id') AND (v_prev.details ? 'command_id')
       AND v_prev.details->>'command_id' IS DISTINCT FROM NEW.details->>'command_id' THEN
      v_evidence := false;
    END IF;

    IF v_rank_new > v_rank_prev AND v_evidence AND NOT v_local_claim THEN
      UPDATE public.automation_log
         SET origin          = NEW.origin,
             user_id         = COALESCE(NEW.user_id, user_id),
             user_email      = COALESCE(NEW.user_email, user_email),
             actor_label     = CASE
                                 WHEN NEW.actor_label IS NOT NULL
                                      AND NOT public.is_technical_actor_label(NEW.actor_label)
                                   THEN NEW.actor_label
                                 WHEN public.is_technical_actor_label(actor_label) THEN NULL
                                 ELSE actor_label END,
             source_device   = COALESCE(NEW.source_device, source_device),
             client_event_id = COALESCE(client_event_id, NEW.client_event_id),
             details         = COALESCE(details, '{}'::jsonb)
                               || jsonb_build_object(
                                    'attribution_upgraded_from', v_prev.origin::text,
                                    'attribution_rank', v_rank_new,
                                    'command_id', COALESCE(NEW.details->>'command_id',
                                                           v_prev.details->>'command_id'))
       WHERE id = v_prev.id;
      RETURN NULL;
    END IF;

    IF v_rank_new > v_rank_prev THEN
      INSERT INTO public.agent_technical_events (farm_id, equipment_id, equipment_name, kind, occurred_at, details)
      VALUES (NEW.farm_id, NEW.equipment_id, NEW.equipment_name, 'state_conflict', NEW.occurred_at,
              COALESCE(NEW.details, '{}'::jsonb) || jsonb_build_object(
                'reason', 'atribuicao_sem_correlacao_forte',
                'intended_origin', NEW.origin::text, 'user_id', NEW.user_id,
                'physical_row_declared_origin', v_prev_decl,
                'note', 'comando na janela sem vínculo com a linha física — atribuição não aplicada'));
      RETURN NULL;
    END IF;
  END IF;

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
    RETURN NULL;
  END IF;

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
CREATE OR REPLACE FUNCTION public.audit_automation_log_integrity(
  _lookback interval DEFAULT interval '48 hours',
  _threshold int DEFAULT 20)
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE v_marked int := 0; v_n int; r record;
BEGIN
  UPDATE public.automation_log
     SET noise_reason = CASE WHEN equipment_id IS NULL THEN 'no_equipment' ELSE 'reading_origin' END
   WHERE occurred_at > now() - _lookback
     AND noise_reason IS NULL
     AND action IN ('turn_on','turn_off','pump_on','pump_off')
     AND (equipment_id IS NULL OR origin = 'reading'::public.event_origin);
  GET DIAGNOSTICS v_n = ROW_COUNT; v_marked := v_marked + v_n;

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

  INSERT INTO public.automation_log_noise_stats (farm_id, equipment_id, day, reason, hits)
  SELECT farm_id, equipment_id, occurred_at::date, noise_reason, count(*)::int
    FROM public.automation_log
   WHERE occurred_at > now() - _lookback AND noise_reason IS NOT NULL
   GROUP BY farm_id, equipment_id, occurred_at::date, noise_reason
  ON CONFLICT (farm_id, equipment_id, day, reason)
  DO UPDATE SET hits = EXCLUDED.hits, updated_at = now();

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
  RAISE NOTICE 'pg_cron indisponível (%) — agende manualmente.', SQLERRM;
END $$;

-- ── 7) COMPENSAÇÃO ──────────────────────────────────────────────────────────
UPDATE public.automation_log
   SET action = CASE
         WHEN details->>'frame' ~ '\{0*1\}' THEN 'turn_on'::public.event_action
         ELSE 'turn_off'::public.event_action END
 WHERE action = 'status_read'::public.event_action
   AND noise_reason = 'not_confirmed'
   AND details ? 'frame';

DELETE FROM public.automation_log
 WHERE action = 'status_read'::public.event_action
   AND noise_reason = 'reading_origin';

WITH marcada AS (
  SELECT n.id AS noise_id, n.farm_id, n.equipment_id, n.origin, n.user_id, n.user_email,
         n.actor_label, n.source_device, n.details, n.occurred_at,
         (CASE WHEN n.action IN ('turn_on','pump_on') THEN 1 ELSE 0 END) AS st
    FROM public.automation_log n
   WHERE n.noise_reason IN ('repeated_state','not_confirmed')
     AND n.action IN ('turn_on','turn_off','pump_on','pump_off')
     AND n.equipment_id IS NOT NULL
     AND ( (n.origin = 'remote'::public.event_origin
            AND (n.user_id IS NOT NULL OR lower(COALESCE(n.source_device,'')) LIKE 'whatsapp:%'))
        OR (n.origin = 'auto'::public.event_origin AND COALESCE(n.actor_label,'') <> '') )
),
alvo AS (
  SELECT DISTINCT ON (m.noise_id) m.*, o.id AS official_id,
         public.automation_attribution_rank(o.origin, o.user_id, o.source_device, o.actor_label) AS rank_of
    FROM marcada m
    JOIN public.automation_log o
      ON o.farm_id = m.farm_id
     AND o.equipment_id = m.equipment_id
     AND o.noise_reason IS NULL
     AND o.action IN ('turn_on','turn_off','pump_on','pump_off')
     AND (CASE WHEN o.action IN ('turn_on','pump_on') THEN 1 ELSE 0 END) = m.st
     AND o.occurred_at BETWEEN m.occurred_at - interval '180 seconds'
                           AND m.occurred_at + interval '180 seconds'
   ORDER BY m.noise_id, abs(extract(epoch FROM (o.occurred_at - m.occurred_at)))
)
UPDATE public.automation_log o
   SET origin        = a.origin,
       user_id       = COALESCE(a.user_id, o.user_id),
       user_email    = COALESCE(a.user_email, o.user_email),
       actor_label   = CASE
                         WHEN a.actor_label IS NOT NULL
                              AND NOT public.is_technical_actor_label(a.actor_label)
                           THEN a.actor_label
                         WHEN public.is_technical_actor_label(o.actor_label) THEN NULL
                         ELSE o.actor_label END,
       source_device = COALESCE(a.source_device, o.source_device),
       result        = 'success'::public.event_result,
       details       = COALESCE(o.details, '{}'::jsonb) || jsonb_build_object(
                         'attribution_recovered_from', a.noise_id,
                         'attribution_source', 'linha_de_comando_marcada',
                         'command_id', COALESCE(a.details->>'command_id', o.details->>'command_id'))
  FROM alvo a
 WHERE o.id = a.official_id
   AND public.automation_attribution_rank(a.origin, a.user_id, a.source_device, a.actor_label) > a.rank_of;

UPDATE public.automation_log n
   SET noise_reason = NULL,
       result       = 'success'::public.event_result,
       details      = COALESCE(n.details, '{}'::jsonb)
                      || jsonb_build_object('attribution_source', 'linha_de_comando_restaurada')
 WHERE n.noise_reason IN ('repeated_state','not_confirmed')
   AND n.action IN ('turn_on','turn_off','pump_on','pump_off')
   AND n.equipment_id IS NOT NULL
   AND n.origin = 'remote'::public.event_origin
   AND (n.user_id IS NOT NULL OR lower(COALESCE(n.source_device,'')) LIKE 'whatsapp:%')
   AND NOT EXISTS (
     SELECT 1 FROM public.automation_log o
      WHERE o.farm_id = n.farm_id AND o.equipment_id = n.equipment_id
        AND o.noise_reason IS NULL
        AND o.action IN ('turn_on','turn_off','pump_on','pump_off')
        AND (CASE WHEN o.action IN ('turn_on','pump_on') THEN 1 ELSE 0 END)
          = (CASE WHEN n.action IN ('turn_on','pump_on') THEN 1 ELSE 0 END)
        AND o.occurred_at BETWEEN n.occurred_at - interval '180 seconds'
                              AND n.occurred_at + interval '180 seconds');

UPDATE public.automation_log al
   SET origin  = 'remote'::public.event_origin,
       details = COALESCE(details, '{}'::jsonb) || jsonb_build_object(
                   'attribution_backfilled', true,
                   'attribution_unavailable', true,
                   'attribution_note', 'Remoto — atribuição histórica indisponível',
                   'attribution_evidence', details->>'origin')
 WHERE al.noise_reason IS NULL
   AND al.action IN ('turn_on','turn_off','pump_on','pump_off')
   AND al.user_id IS NULL
   AND NOT (al.details ? 'command_id')
   AND lower(COALESCE(al.details->>'origin','')) IN ('remote-cmd','remote-desired','remote_cmd','remote_desired')
   AND al.origin IS DISTINCT FROM 'remote'::public.event_origin;

WITH unico AS (
  SELECT e.id AS equipment_id, (array_agg(p.id))[1] AS user_id,
         (array_agg(p.email))[1] AS email, (array_agg(p.full_name))[1] AS full_name
    FROM public.equipments e
    JOIN public.profiles p
      ON p.full_name = e.last_changed_by OR p.email = e.last_changed_by
   WHERE e.last_changed_by IS NOT NULL
   GROUP BY e.id
  HAVING count(DISTINCT p.id) = 1
)
UPDATE public.automation_log al
   SET user_id     = u.user_id,
       user_email  = u.email,
       actor_label = COALESCE(al.actor_label, u.full_name, u.email),
       details     = al.details || jsonb_build_object(
                       'attribution_unavailable', false,
                       'attribution_source', 'last_changed_by')
  FROM unico u
 WHERE al.equipment_id = u.equipment_id
   AND (al.details->>'attribution_backfilled')::boolean IS TRUE
   AND al.user_id IS NULL;

INSERT INTO public.agent_technical_events (farm_id, equipment_id, equipment_name, kind, occurred_at, details)
SELECT farm_id, equipment_id, equipment_name, 'state_conflict', occurred_at,
       jsonb_build_object('reason', 'atribuicao_historica_indisponivel',
                          'note', 'Remoto — atribuição histórica indisponível',
                          'evidence', details->>'attribution_evidence')
  FROM public.automation_log
 WHERE (details->>'attribution_backfilled')::boolean IS TRUE
   AND (details->>'attribution_unavailable')::boolean IS TRUE;

UPDATE public.automation_log
   SET actor_label = NULL,
       details     = COALESCE(details, '{}'::jsonb)
                     || jsonb_build_object('confirmation_method', actor_label)
 WHERE action IN ('turn_on','turn_off','pump_on','pump_off')
   AND public.is_technical_actor_label(actor_label);

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