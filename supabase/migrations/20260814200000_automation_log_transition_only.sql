-- ============================================================================
-- RELATÓRIO DE AUTOMAÇÃO — só TRANSIÇÃO CONFIRMADA vira linha. (TODAS as fazendas)
-- ----------------------------------------------------------------------------
-- DIAGNÓSTICO (o guard de 20260710002546 existia, mas tinha três vazamentos):
--
--  1) `IF NEW.result IS NOT NULL AND NEW.result <> 'success' THEN RETURN NEW;`
--     — qualquer linha com result fail/timeout/pending ESCAPAVA da deduplicação
--     inteira. `trg_log_manual_command` grava action=turn_off + result='fail'
--     quando o comando não confirma; essa linha entrava no log e o relatório a
--     desenhava como "Desligada" (com selo Falhou, mas ocupando uma linha de
--     transição). Um comando que FALHOU virava evento de estado.
--
--  2) Linhas com origin='reading' e action=turn_on/turn_off (observação de
--     telemetria, não comando) passavam pelo mesmo caminho. O frontend as
--     reclassificava para "Leitura OK" em `classifyAction` — ou seja, a correção
--     estava no VISUAL, escondendo o defeito da fonte.
--
--  3) `equipment_id IS NULL` passava direto, sem chance de deduplicar.
--
-- REGRA NOVA (única e server-side):
--   Uma linha só é TRANSIÇÃO se: tem equipamento + é confirmação (result
--   'success') + não é leitura + o estado REALMENTE mudou vs last_confirmed_state.
--   Repetido (OFF→OFF / ON→ON) NUNCA gera linha.
--   O que não é transição não some: é rebaixado a `status_read` com
--   `noise_reason`, ficando na trilha técnica e FORA do histórico oficial.
--
-- Consequência desejada: polling, startup, retry, eco, reconexão e resposta
-- intermediária de comando deixam de entrar no relatório. TX espontâneo que
-- alterna o estado entra sempre — inclusive dois em menos de um minuto, porque
-- o critério é MUDANÇA DE ESTADO, não tempo.
--
-- Não toca relé, bridge, automação, pump_runtime, WhatsApp, FASE 2, licença nem OTA.
-- Idempotente.
-- ============================================================================

-- ── 1) Marcação de ruído (NULL = evento oficial válido) ─────────────────────
ALTER TABLE public.automation_log
  ADD COLUMN IF NOT EXISTS noise_reason text;

COMMENT ON COLUMN public.automation_log.noise_reason IS
  'NULL = transição confirmada (entra no relatório oficial). Preenchido = ruído técnico '
  '(not_confirmed | reading_origin | no_equipment | repeated_state) — fica na trilha, fora do histórico.';

-- O relatório oficial lê sempre com noise_reason IS NULL; este índice serve a ele.
CREATE INDEX IF NOT EXISTS idx_automation_log_official
  ON public.automation_log (farm_id, occurred_at DESC)
  WHERE noise_reason IS NULL
    AND action IN ('turn_on','turn_off','pump_on','pump_off');

CREATE INDEX IF NOT EXISTS idx_automation_log_equip_time
  ON public.automation_log (equipment_id, occurred_at)
  WHERE equipment_id IS NOT NULL;

-- ── 2) Guarda única de transição ────────────────────────────────────────────
-- Dispara por ÚLTIMO entre os BEFORE INSERT de automation_log (ordem alfabética:
-- trg_attribute_scheduled_shutdown → trg_enforce_automation_log_actor →
-- trg_enforce_automation_log_state_change), portanto já enxerga origin/result
-- finais depois da atribuição de origem.
CREATE OR REPLACE FUNCTION public.enforce_automation_log_state_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_state SMALLINT;
  v_last_state SMALLINT;
  v_demote text := NULL;
BEGIN
  -- Ações que não afirmam estado (status_read, mode_change, reset, polling)
  -- seguem como auditoria, sem interferência.
  IF NEW.action NOT IN ('turn_on','turn_off','pump_on','pump_off') THEN
    RETURN NEW;
  END IF;

  -- ── Motivos para NÃO ser transição oficial ────────────────────────────────
  IF NEW.equipment_id IS NULL THEN
    -- sem equipamento não há estado anterior com que comparar
    v_demote := 'no_equipment';

  ELSIF NEW.origin = 'reading'::public.event_origin THEN
    -- observação de telemetria (polling/eco/reconexão) nunca é evento operacional
    v_demote := 'reading_origin';

  ELSIF NEW.result IS DISTINCT FROM 'success'::public.event_result THEN
    -- fail / timeout / pending / NULL: o comando NÃO confirmou o estado.
    -- Era o vazamento nº 1 — antes isto pulava a deduplicação por completo.
    v_demote := 'not_confirmed';
  END IF;

  IF v_demote IS NOT NULL THEN
    NEW.action := 'status_read'::public.event_action;
    NEW.noise_reason := v_demote;
    RETURN NEW;   -- preservado como telemetria técnica, fora do relatório
  END IF;

  v_new_state := CASE WHEN NEW.action IN ('turn_on','pump_on') THEN 1 ELSE 0 END;

  SELECT last_confirmed_state INTO v_last_state
    FROM public.equipments
   WHERE id = NEW.equipment_id
   FOR UPDATE;

  IF v_last_state IS NOT NULL AND v_last_state = v_new_state THEN
    -- Estado repetido (OFF→OFF ou ON→ON): NUNCA gera nova linha.
    RETURN NULL;
  END IF;

  -- Transição real: move o estado confirmado e mantém a linha.
  UPDATE public.equipments
     SET last_confirmed_state = v_new_state
   WHERE id = NEW.equipment_id;

  NEW.noise_reason := NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_enforce_automation_log_state_change ON public.automation_log;
CREATE TRIGGER trg_enforce_automation_log_state_change
BEFORE INSERT ON public.automation_log
FOR EACH ROW
EXECUTE FUNCTION public.enforce_automation_log_state_change();
