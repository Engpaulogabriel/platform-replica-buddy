-- ============================================================================
-- ORIGEM DA ÚLTIMA ATUAÇÃO — parar de chamar automação e comando remoto de LOCAL.
-- ----------------------------------------------------------------------------
-- O agente grava `equipments.last_actuation_origin = 'local'` quando vê o
-- estado físico mudar sem um comando casado no cache dele. Depois do
-- desligamento das 17h a confirmação chega, ele não encontra comando, e o
-- dashboard passa a mostrar o selo amarelo LOCAL — como se alguém tivesse ido
-- até a botoeira. O Relatório, no mesmo horário, acerta.
--
-- Esta migration faz o dashboard usar EXATAMENTE a mesma cadeia canônica que o
-- Relatório já usa, definida no trigger de automation_log
-- (20260811270000_scheduled_shutdown_window_trigger.sql):
--
--   A) comando `backend-reset:scheduled_shutdown%` na janela
--      → auto, com a regra vinda de equipments.last_changed_by
--   B) FALLBACK POR JANELA de scheduled_automations (dia da semana + horário)
--      → auto, com o nome da regra
--   C) comando remoto manual compatível → remote
--   D) nada disso → local (TX espontâneo de verdade)
--
-- `scheduled_shutdowns.targeted` NÃO é critério. Ele guarda apenas o `acted` da
-- ÚLTIMA tentativa (edge function, linha 137: `patch.targeted = acted`), e
-- `acted` só percorre as bombas ainda LIGADAS naquele passo. Por isso 13/08
-- ficou `[]` e 14/08 trouxe só o POÇO 11 R4 forced: os demais desligaram em
-- tentativas anteriores e foram sobrescritos. Usá-lo como prova deixaria a
-- maioria dos poços rebaixada para Local. Ele entra só como evidência
-- COMPLEMENTAR, para marcar quais casos foram forçados.
--
-- PRINCÍPIO: a confirmação física prova o ESTADO, nunca a ORIGEM.
--
-- Não altera relés, rádio, bridge, polling, agente, Realtime, proteção de
-- comutação, as automações em si, o Relatório de Automação, autoria, FASE 2/3,
-- OTA, WhatsApp, energia nem INEMA. Nenhuma linha de automation_log é tocada.
-- ============================================================================

ALTER TABLE public.equipments
  ADD COLUMN IF NOT EXISTS last_actuation_rule text;
COMMENT ON COLUMN public.equipments.last_actuation_rule IS
  'Nome da regra de automação que originou a última atuação, quando last_actuation_origin = auto. Detalhe técnico.';

-- ── Correlação canônica ─────────────────────────────────────────────────────
-- Mesma ordem do Relatório. `_at` é o instante da confirmação física — nunca
-- now() fixo — para a correção histórica avaliar a janela do dia certo.
CREATE OR REPLACE FUNCTION public.classify_actuation_origin(
  _equipment_id uuid, _farm_id uuid, _turning_on boolean,
  _at timestamptz DEFAULT now())
RETURNS TABLE (origin text, rule_name text, evidence text, forced boolean)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rule text; v_brt timestamp; v_min int; v_dow text; v_forced boolean := false;
BEGIN
  -- Evidência COMPLEMENTAR (nunca decide): este poço aparece como 'forced' na
  -- última tentativa registrada? Serve só para diagnóstico.
  SELECT true INTO v_forced
    FROM public.scheduled_shutdowns s,
         LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(COALESCE(s.targeted,'[]'::jsonb)) = 'array'
                THEN s.targeted ELSE '[]'::jsonb END) t
   WHERE s.farm_id = _farm_id
     AND t->>'id' = _equipment_id::text
     AND t->>'action' = 'forced'
     AND COALESCE(s.last_attempt_at, s.updated_at) BETWEEN _at - interval '30 minutes'
                                                       AND _at + interval '30 minutes'
   LIMIT 1;
  v_forced := COALESCE(v_forced, false);

  -- Só DESLIGAMENTO pode vir do desligamento programado.
  IF NOT _turning_on THEN

    -- ── (A) comando gerado pela automação, por equipamento ─────────────────
    -- enqueue_reset_pump_command grava source_device =
    -- 'backend-reset:scheduled_shutdown_aN[_forced]' para CADA bomba atuada,
    -- forced ou não. É a prova durável por poço.
    IF EXISTS (
      SELECT 1 FROM public.commands c
       WHERE c.equipment_id = _equipment_id
         AND c.source_device LIKE 'backend-reset:scheduled_shutdown%'
         AND c.created_at BETWEEN _at - interval '10 minutes' AND _at + interval '2 minutes'
    ) THEN
      SELECT NULLIF(btrim(e.last_changed_by), '') INTO v_rule
        FROM public.equipments e WHERE e.id = _equipment_id;
      RETURN QUERY SELECT 'auto', COALESCE(v_rule, 'Desligamento Programado'),
                          'command_scheduled_shutdown', v_forced;
      RETURN;
    END IF;

    -- ── (B) FALLBACK POR JANELA — não depende de comando ───────────────────
    -- É este caminho que faz o Relatório acertar TODOS os poços, inclusive
    -- quando o comando já saiu da janela. Espelha o trigger do Relatório,
    -- inclusive o fuso America/Bahia.
    v_brt := (_at AT TIME ZONE 'America/Bahia');
    v_min := (extract(hour from v_brt)::int) * 60 + (extract(minute from v_brt)::int);
    v_dow := (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[(extract(dow from v_brt)::int) + 1];

    SELECT sa.name INTO v_rule
      FROM public.scheduled_automations sa
     WHERE sa.farm_id = _farm_id
       AND sa.is_active = true
       AND sa.time_brt ~ '^[0-9]{1,2}:[0-9]{2}'
       AND (sa.days_of_week IS NULL
            OR array_length(sa.days_of_week, 1) IS NULL
            OR v_dow = ANY(sa.days_of_week))
       AND v_min >= ((substring(sa.time_brt from '^([0-9]{1,2})')::int) * 60
                     + (substring(sa.time_brt from ':([0-9]{2})')::int)) - 5
       AND v_min <= ((substring(sa.time_brt from '^([0-9]{1,2})')::int) * 60
                     + (substring(sa.time_brt from ':([0-9]{2})')::int))
                    + (COALESCE(sa.max_retries, 3) * COALESCE(sa.retry_interval_min, 5)) + 5
     ORDER BY sa.time_brt
     LIMIT 1;

    IF v_rule IS NOT NULL THEN
      RETURN QUERY SELECT 'auto', v_rule, 'time_window', v_forced;
      RETURN;
    END IF;
  END IF;

  -- ── (C) comando remoto manual compatível ─────────────────────────────────
  IF EXISTS (
    SELECT 1 FROM public.commands c
     WHERE c.equipment_id = _equipment_id
       AND c.type = 'manual'::public.command_type
       AND c.created_at BETWEEN _at - interval '10 minutes' AND _at + interval '2 minutes'
       AND ((_turning_on AND c.frame ~ '\{0*1\}') OR (NOT _turning_on AND c.frame ~ '\{0*0\}'))
  ) THEN
    RETURN QUERY SELECT 'remote', NULL::text, 'manual_command', v_forced;
    RETURN;
  END IF;

  -- ── (D) TX espontâneo sem contexto: atuação local de verdade ─────────────
  RETURN QUERY SELECT 'local', NULL::text, 'spontaneous_tx', v_forced;
END; $$;
GRANT EXECUTE ON FUNCTION public.classify_actuation_origin(uuid, uuid, boolean, timestamptz)
  TO authenticated, service_role;

-- ── Trigger: intercepta só quando alguém tenta gravar 'local' ──────────────
CREATE OR REPLACE FUNCTION public.canonicalize_actuation_origin()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_on boolean; v_res record;
BEGIN
  IF NEW.last_actuation_origin IS DISTINCT FROM 'local' THEN
    RETURN NEW;                       -- origem já classificada passa intacta
  END IF;
  IF NEW.last_actuation_origin IS NOT DISTINCT FROM OLD.last_actuation_origin
     AND NEW.last_outputs_state IS NOT DISTINCT FROM OLD.last_outputs_state THEN
    RETURN NEW;                       -- nada mudou de fato
  END IF;

  v_on := COALESCE(NEW.last_outputs_state, '') ~ '1';
  SELECT * INTO v_res
    FROM public.classify_actuation_origin(NEW.id, NEW.farm_id, v_on, now());

  NEW.last_actuation_origin := v_res.origin;
  NEW.last_actuation_rule   := CASE WHEN v_res.origin = 'auto' THEN v_res.rule_name ELSE NULL END;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_canonicalize_actuation_origin ON public.equipments;
CREATE TRIGGER trg_canonicalize_actuation_origin
BEFORE UPDATE OF last_actuation_origin, last_outputs_state ON public.equipments
FOR EACH ROW EXECUTE FUNCTION public.canonicalize_actuation_origin();

-- ── Correção dos registros recentes já contaminados ────────────────────────
-- SOMENTE onde a prova é de AUTOMAÇÃO (caminho A ou B). Comando humano real
-- fica como está — correção retroativa não chuta. Nenhuma linha do Relatório
-- de Automação é tocada.
CREATE OR REPLACE FUNCTION public.fix_contaminated_local_origin(_hours int DEFAULT 24)
RETURNS TABLE (equipment_id uuid, equipamento text, de text, para text,
               regra text, evidencia text, forcado boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record; v record;
BEGIN
  FOR r IN
    SELECT e.id, e.name, e.farm_id, e.last_outputs_state, e.updated_at
      FROM public.equipments e
     WHERE e.last_actuation_origin = 'local'
       AND e.updated_at > now() - make_interval(hours => _hours)
  LOOP
    SELECT * INTO v FROM public.classify_actuation_origin(
      r.id, r.farm_id, COALESCE(r.last_outputs_state,'') ~ '1', r.updated_at);

    IF v.origin = 'auto' THEN
      UPDATE public.equipments
         SET last_actuation_origin = 'auto', last_actuation_rule = v.rule_name
       WHERE id = r.id;
      RETURN QUERY SELECT r.id, r.name, 'local'::text, 'auto'::text,
                          v.rule_name, v.evidence, v.forced;
    END IF;
  END LOOP;
END; $$;
GRANT EXECUTE ON FUNCTION public.fix_contaminated_local_origin(int) TO service_role;

-- ============================================================================
-- CONFERÊNCIA
--   SELECT name, last_actuation_origin, last_actuation_rule
--     FROM public.equipments WHERE last_actuation_origin = 'local';
--   SELECT * FROM public.fix_contaminated_local_origin(72);   -- mostra o que muda
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_canonicalize_actuation_origin ON public.equipments;
-- ============================================================================
