-- ============================================================================
-- TRAVA OPERACIONAL DE COMUTAÇÃO — 30s por poço, após CONFIRMAÇÃO FÍSICA.
-- ----------------------------------------------------------------------------
-- Evita liga/desliga em curto prazo: desgaste do equipamento, sequência confusa
-- no relatório e perda de autoria em transições rápidas.
--
-- PRINCÍPIO: a trava NÃO começa no clique nem no comando pendente. Ela começa
-- quando a bomba CONFIRMA fisicamente a mudança de estado — e é o servidor que
-- decide, não o navegador. O frontend só espelha `command_lock_until`.
--
-- Idempotente. Não altera relé, agente, FASE 2/3, OTA, energia, INEMA, WhatsApp
-- nem o Relatório de Automação (comando recusado não vira evento oficial).
-- ============================================================================

-- ── 1) Estado da trava, no próprio equipamento ──────────────────────────────
ALTER TABLE public.equipments
  ADD COLUMN IF NOT EXISTS command_lock_until              timestamptz,
  ADD COLUMN IF NOT EXISTS last_confirmed_transition_at    timestamptz,
  ADD COLUMN IF NOT EXISTS last_confirmed_transition_state boolean;

COMMENT ON COLUMN public.equipments.command_lock_until IS
  'Proteção de comutação: novos comandos remotos ON/OFF são recusados até este instante. Definido pela CONFIRMAÇÃO FÍSICA, nunca pelo clique.';

CREATE INDEX IF NOT EXISTS idx_equipments_lock
  ON public.equipments (id) WHERE command_lock_until IS NOT NULL;

-- Janela da trava, configurável por fazenda (default 30s).
ALTER TABLE public.farms
  ADD COLUMN IF NOT EXISTS switching_protection_seconds int NOT NULL DEFAULT 30;

-- ── 2) A trava nasce da CONFIRMAÇÃO FÍSICA ──────────────────────────────────
-- Trigger em equipments: quando o estado derivado de last_outputs_state MUDA,
-- isso é a confirmação física. Atômico com a própria escrita da telemetria
-- (apply_pump_telemetry faz UPDATE em equipments), sem reescrever aquela função.
CREATE OR REPLACE FUNCTION public.arm_switching_protection()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_old boolean; v_new boolean; v_secs int;
BEGIN
  -- estado físico = existe algum bit 1 no payload de saídas
  v_old := COALESCE(OLD.last_outputs_state, '') ~ '1';
  v_new := COALESCE(NEW.last_outputs_state, '') ~ '1';

  -- só CONFIRMAÇÃO DE MUDANÇA arma a trava; leitura repetida não rearma
  IF NEW.last_outputs_state IS NULL OR v_old = v_new THEN
    RETURN NEW;
  END IF;

  SELECT COALESCE(f.switching_protection_seconds, 30) INTO v_secs
    FROM public.farms f WHERE f.id = NEW.farm_id;

  NEW.last_confirmed_transition_at    := now();
  NEW.last_confirmed_transition_state := v_new;
  NEW.command_lock_until              := now() + make_interval(secs => COALESCE(v_secs, 30));
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_arm_switching_protection ON public.equipments;
CREATE TRIGGER trg_arm_switching_protection
BEFORE UPDATE OF last_outputs_state ON public.equipments
FOR EACH ROW EXECUTE FUNCTION public.arm_switching_protection();

-- ── 3) Recusa server-side de comando remoto durante a trava ─────────────────
-- Ponto único de estrangulamento: TODO caminho remoto (dashboard, API,
-- WhatsApp, RPC, edge) acaba num INSERT em `commands`. Bloquear aqui cobre
-- todos de uma vez, inclusive os que eu não conheço.
--
-- NÃO bloqueia: polling, reset/proteção (priority 0), desligamento forçado,
-- backend-reset e automação de segurança — prioridade operacional preservada.
CREATE OR REPLACE FUNCTION public.enforce_switching_protection()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_lock timestamptz; v_at timestamptz; v_rest int; v_src text;
BEGIN
  IF NEW.equipment_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.type <> 'manual'::public.command_type THEN RETURN NEW; END IF;

  v_src := lower(COALESCE(NEW.source_device, ''));
  -- Prioridade absoluta: segurança, proteção do PLC e emergência passam sempre.
  IF COALESCE(NEW.priority, 5) = 0
     OR v_src LIKE 'backend-reset%'
     OR v_src LIKE 'forced-shutdown%'
     OR v_src LIKE 'cloud-protective%'
     OR v_src LIKE 'safety%' THEN
    RETURN NEW;
  END IF;

  -- Serializa por equipamento: duas requisições simultâneas não passam juntas.
  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.equipment_id::text, 77));

  SELECT e.command_lock_until, e.last_confirmed_transition_at
    INTO v_lock, v_at
    FROM public.equipments e WHERE e.id = NEW.equipment_id FOR UPDATE;

  IF v_lock IS NULL OR now() >= v_lock THEN
    RETURN NEW;   -- livre
  END IF;

  v_rest := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_lock - now())))::int);

  -- LIMITAÇÃO CONHECIDA, DELIBERADA: não registramos a recusa aqui. O RAISE
  -- abaixo aborta a transação e levaria junto qualquer INSERT de trilha feito
  -- neste mesmo escopo (Postgres não tem transação autônoma). A mensagem clara
  -- ao operador tem prioridade sobre o log. Quem quiser a trilha deve chamar
  -- antes `public.check_switching_protection()`, que registra e commita.
  -- Mensagem SEM tempo: o usuário não precisa (e não deve) ver relógio técnico.
  -- Os segundos restantes seguem disponíveis para diagnóstico em
  -- switching_protection_status(), restrito ao Setor Técnico.
  RAISE EXCEPTION USING
    ERRCODE = 'check_violation',
    MESSAGE = 'Proteção de comutação ativa. Aguarde a liberação antes de novo comando.',
    HINT    = 'switching_protection_active';
END; $$;

DROP TRIGGER IF EXISTS trg_enforce_switching_protection ON public.commands;
CREATE TRIGGER trg_enforce_switching_protection
BEFORE INSERT ON public.commands
FOR EACH ROW EXECUTE FUNCTION public.enforce_switching_protection();

-- ── 3.1) Pré-checagem com TRILHA (chamada ANTES de tentar o comando) ────────
-- Devolve se está livre e, quando recusado, registra a tentativa em
-- agent_technical_events com motivo 'switching_protection_active'. Como não
-- lança exceção, o INSERT da trilha commita normalmente. O trigger acima segue
-- como garantia dura para quem não chamar esta função.
CREATE OR REPLACE FUNCTION public.check_switching_protection(
  _equipment_id uuid, _requested_by uuid DEFAULT NULL, _source_device text DEFAULT NULL)
RETURNS TABLE (allowed boolean, seconds_remaining int, message text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_lock timestamptz; v_at timestamptz; v_farm uuid; v_rest int;
BEGIN
  SELECT e.command_lock_until, e.last_confirmed_transition_at, e.farm_id
    INTO v_lock, v_at, v_farm
    FROM public.equipments e WHERE e.id = _equipment_id;

  IF v_lock IS NULL OR now() >= v_lock THEN
    RETURN QUERY SELECT true, 0, NULL::text; RETURN;
  END IF;

  v_rest := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_lock - now())))::int);

  BEGIN
    INSERT INTO public.agent_technical_events (farm_id, equipment_id, kind, occurred_at, details)
    VALUES (v_farm, _equipment_id, 'command_not_confirmed', now(),
            jsonb_build_object('reason', 'switching_protection_active',
                               'seconds_remaining', v_rest,
                               'last_confirmed_at', v_at,
                               'requested_by', _requested_by,
                               'source_device', _source_device));
  EXCEPTION WHEN OTHERS THEN NULL;   -- trilha é best-effort, nunca bloqueia
  END;

  -- idem: mensagem simples ao usuário; v_rest fica só no retorno estruturado,
  -- para o Setor Técnico, nunca para o card operacional.
  RETURN QUERY SELECT false, v_rest,
    'Proteção de comutação ativa. Aguarde a liberação antes de novo comando.'::text;
END; $$;
GRANT EXECUTE ON FUNCTION public.check_switching_protection(uuid, uuid, text) TO authenticated, service_role;

-- ── 4) Consulta de estado da trava (para UI e diagnóstico) ──────────────────
CREATE OR REPLACE FUNCTION public.switching_protection_status(_equipment_id uuid)
RETURNS TABLE (locked boolean, seconds_remaining int, last_confirmed_at timestamptz, last_state boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.command_lock_until IS NOT NULL AND now() < e.command_lock_until,
         GREATEST(0, CEIL(EXTRACT(EPOCH FROM (e.command_lock_until - now())))::int),
         e.last_confirmed_transition_at,
         e.last_confirmed_transition_state
    FROM public.equipments e WHERE e.id = _equipment_id;
$$;
GRANT EXECUTE ON FUNCTION public.switching_protection_status(uuid) TO authenticated, service_role;

-- ── 5) Realtime já publica `equipments` (REPLICA IDENTITY FULL) ─────────────
-- As três colunas novas viajam no payload do UPDATE, então o dashboard recebe
-- command_lock_until sem consulta extra e conta o tempo sozinho.

-- ============================================================================
-- CONFERÊNCIA
--   SELECT name, command_lock_until, last_confirmed_transition_at,
--          last_confirmed_transition_state
--     FROM public.equipments WHERE farm_id = '<uuid>' ORDER BY name;
--   SELECT * FROM public.switching_protection_status('<equipment_id>');
--   -- recusas registradas (fora do relatório oficial):
--   SELECT occurred_at, details FROM public.agent_technical_events
--    WHERE details->>'reason' = 'switching_protection_active' ORDER BY occurred_at DESC;
--
-- ROLLBACK:
--   DROP TRIGGER IF EXISTS trg_enforce_switching_protection ON public.commands;
--   DROP TRIGGER IF EXISTS trg_arm_switching_protection ON public.equipments;
--   -- (as colunas podem permanecer; sem os triggers elas ficam inertes)
-- ============================================================================
