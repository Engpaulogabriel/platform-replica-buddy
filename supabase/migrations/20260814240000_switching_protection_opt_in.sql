-- ============================================================================
-- PROTEÇÃO DE COMUTAÇÃO — de global/visível para OPT-IN POR POÇO e invisível.
-- ----------------------------------------------------------------------------
-- A função foi publicada ativa para TODOS os poços e aparecendo no card do
-- cliente. Isso está errado. Ela passa a:
--   • nascer DESLIGADA em todo equipamento (DEFAULT false);
--   • só travar o poço cujo `switching_protection_enabled` for true;
--   • quando desligada, ser COMPLETAMENTE inerte — não arma, não bloqueia,
--     não registra e não devolve nada para a tela;
--   • ser configurável apenas por platform_admin/platform_support.
--
-- A estrutura NÃO é apagada. Não toca agente, rádio, bridge, Realtime, relés,
-- FASE 2/3, OTA, automações, energia, INEMA nem o Relatório de Automação.
-- Manutenção e demais bloqueios de segurança seguem intactos.
-- ============================================================================

-- ── 1) O interruptor, por equipamento ───────────────────────────────────────
ALTER TABLE public.equipments
  ADD COLUMN IF NOT EXISTS switching_protection_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS switching_protection_seconds int;   -- NULL = usa o default

COMMENT ON COLUMN public.equipments.switching_protection_enabled IS
  'Proteção de comutação: OPT-IN por poço, desligada por padrão. Só platform_admin/platform_support alteram. Quando false a função é inerte.';
COMMENT ON COLUMN public.equipments.switching_protection_seconds IS
  'Janela de proteção deste poço em segundos. NULL usa farms.switching_protection_seconds (default 30).';

-- ── 2) DESARME IMEDIATO do que já foi publicado ─────────────────────────────
-- Nenhum poço pode continuar bloqueado por uma função que agora nasce desligada.
UPDATE public.equipments
   SET command_lock_until = NULL
 WHERE command_lock_until IS NOT NULL;

-- ── 3) A trava só ARMA em poço habilitado ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.arm_switching_protection()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_old boolean; v_new boolean; v_secs int;
BEGIN
  -- OPT-IN: poço não habilitado nunca arma trava. Sai antes de qualquer coisa.
  IF NOT COALESCE(NEW.switching_protection_enabled, false) THEN
    NEW.command_lock_until := NULL;
    RETURN NEW;
  END IF;

  v_old := COALESCE(OLD.last_outputs_state, '') ~ '1';
  v_new := COALESCE(NEW.last_outputs_state, '') ~ '1';
  IF NEW.last_outputs_state IS NULL OR v_old = v_new THEN RETURN NEW; END IF;

  SELECT COALESCE(NEW.switching_protection_seconds,
                  f.switching_protection_seconds, 30)
    INTO v_secs FROM public.farms f WHERE f.id = NEW.farm_id;

  NEW.last_confirmed_transition_at    := now();
  NEW.last_confirmed_transition_state := v_new;
  NEW.command_lock_until              := now() + make_interval(secs => COALESCE(v_secs, 30));
  RETURN NEW;
END; $$;

-- ── 4) A recusa só vale em poço habilitado ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.enforce_switching_protection()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_lock timestamptz; v_on boolean; v_src text;
BEGIN
  IF NEW.equipment_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.type <> 'manual'::public.command_type THEN RETURN NEW; END IF;

  v_src := lower(COALESCE(NEW.source_device, ''));
  IF COALESCE(NEW.priority, 5) = 0
     OR v_src LIKE 'backend-reset%' OR v_src LIKE 'forced-shutdown%'
     OR v_src LIKE 'cloud-protective%' OR v_src LIKE 'safety%' THEN
    RETURN NEW;
  END IF;

  -- OPT-IN: lê o interruptor ANTES de tomar qualquer lock. Poço desligado
  -- passa direto, sem custo e sem efeito colateral.
  SELECT e.switching_protection_enabled, e.command_lock_until
    INTO v_on, v_lock
    FROM public.equipments e WHERE e.id = NEW.equipment_id;
  IF NOT COALESCE(v_on, false) THEN RETURN NEW; END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(NEW.equipment_id::text, 77));
  SELECT e.command_lock_until INTO v_lock
    FROM public.equipments e WHERE e.id = NEW.equipment_id FOR UPDATE;

  IF v_lock IS NULL OR now() >= v_lock THEN RETURN NEW; END IF;

  RAISE EXCEPTION USING
    ERRCODE = 'check_violation',
    MESSAGE = 'Proteção de comutação ativa. Aguarde a liberação antes de novo comando.',
    HINT    = 'switching_protection_active';
END; $$;

-- ── 5) Pré-checagem: poço desligado não registra NADA ───────────────────────
CREATE OR REPLACE FUNCTION public.check_switching_protection(
  _equipment_id uuid, _requested_by uuid DEFAULT NULL, _source_device text DEFAULT NULL)
RETURNS TABLE (allowed boolean, seconds_remaining int, message text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_lock timestamptz; v_at timestamptz; v_farm uuid; v_rest int; v_on boolean;
BEGIN
  SELECT e.switching_protection_enabled, e.command_lock_until,
         e.last_confirmed_transition_at, e.farm_id
    INTO v_on, v_lock, v_at, v_farm
    FROM public.equipments e WHERE e.id = _equipment_id;

  -- inerte quando desligada: sem bloqueio, sem trilha, sem mensagem
  IF NOT COALESCE(v_on, false) OR v_lock IS NULL OR now() >= v_lock THEN
    RETURN QUERY SELECT true, 0, NULL::text; RETURN;
  END IF;

  v_rest := GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_lock - now())))::int);
  BEGIN
    INSERT INTO public.agent_technical_events (farm_id, equipment_id, kind, occurred_at, details)
    VALUES (v_farm, _equipment_id, 'command_not_confirmed', now(),
            jsonb_build_object('reason','switching_protection_active',
                               'seconds_remaining', v_rest,
                               'requested_by', _requested_by,
                               'source_device', _source_device));
  EXCEPTION WHEN OTHERS THEN NULL;
  END;
  RETURN QUERY SELECT false, v_rest,
    'Proteção de comutação ativa. Aguarde a liberação antes de novo comando.'::text;
END; $$;

-- ── 6) Estado: só responde para poço habilitado ─────────────────────────────
CREATE OR REPLACE FUNCTION public.switching_protection_status(_equipment_id uuid)
RETURNS TABLE (locked boolean, seconds_remaining int, last_confirmed_at timestamptz, last_state boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(e.switching_protection_enabled,false)
           AND e.command_lock_until IS NOT NULL AND now() < e.command_lock_until,
         CASE WHEN COALESCE(e.switching_protection_enabled,false)
              THEN GREATEST(0, CEIL(EXTRACT(EPOCH FROM (e.command_lock_until - now())))::int)
              ELSE 0 END,
         e.last_confirmed_transition_at, e.last_confirmed_transition_state
    FROM public.equipments e WHERE e.id = _equipment_id;
$$;

-- ── 7) AUDITORIA de ativação/desativação ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.switching_protection_audit (
  id           bigserial PRIMARY KEY,
  equipment_id uuid NOT NULL,
  farm_id      uuid,
  enabled      boolean NOT NULL,
  seconds      int,
  changed_by   uuid NOT NULL,
  changed_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sp_audit_equip ON public.switching_protection_audit (equipment_id, changed_at DESC);
ALTER TABLE public.switching_protection_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sp_audit_select ON public.switching_protection_audit;
CREATE POLICY sp_audit_select ON public.switching_protection_audit
  FOR SELECT TO authenticated USING (public.is_platform_staff(auth.uid()));

-- ── 8) O ÚNICO caminho de configuração — restrito a admin/técnico ───────────
CREATE OR REPLACE FUNCTION public.set_switching_protection(
  _equipment_id uuid, _enabled boolean, _seconds int DEFAULT NULL, _actor uuid DEFAULT NULL)
RETURNS TABLE (equipment_id uuid, enabled boolean, seconds int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := COALESCE(_actor, auth.uid()); v_farm uuid;
BEGIN
  IF NOT public.is_platform_staff(v_actor) THEN
    RAISE EXCEPTION 'somente platform_admin ou técnico (platform_support) pode configurar a proteção de comutação';
  END IF;
  IF _seconds IS NOT NULL AND (_seconds < 1 OR _seconds > 600) THEN
    RAISE EXCEPTION 'janela de proteção fora do intervalo permitido (1 a 600 segundos)';
  END IF;

  UPDATE public.equipments e
     SET switching_protection_enabled = _enabled,
         switching_protection_seconds = _seconds,
         -- desligar LIBERA na hora; ligar não trava retroativamente
         command_lock_until = NULL
   WHERE e.id = _equipment_id
  RETURNING e.farm_id INTO v_farm;

  IF v_farm IS NULL THEN RAISE EXCEPTION 'equipamento % não existe', _equipment_id; END IF;

  INSERT INTO public.switching_protection_audit (equipment_id, farm_id, enabled, seconds, changed_by)
  VALUES (_equipment_id, v_farm, _enabled, _seconds, v_actor);

  RETURN QUERY SELECT _equipment_id, _enabled, _seconds;
END; $$;
GRANT EXECUTE ON FUNCTION public.set_switching_protection(uuid, boolean, int, uuid) TO authenticated, service_role;

-- ── 9) Lista para a aba técnica ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.switching_protection_list(_farm_id uuid)
RETURNS TABLE (
  equipment_id uuid, equipment_name text, enabled boolean, seconds int,
  currently_locked boolean, last_change_at timestamptz, last_change_by text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e.id, e.name,
         COALESCE(e.switching_protection_enabled,false),
         COALESCE(e.switching_protection_seconds,
                  (SELECT f.switching_protection_seconds FROM public.farms f WHERE f.id = e.farm_id), 30),
         COALESCE(e.switching_protection_enabled,false)
           AND e.command_lock_until IS NOT NULL AND now() < e.command_lock_until,
         a.changed_at, p.full_name
    FROM public.equipments e
    LEFT JOIN LATERAL (SELECT s.changed_at, s.changed_by
                         FROM public.switching_protection_audit s
                        WHERE s.equipment_id = e.id
                        ORDER BY s.changed_at DESC LIMIT 1) a ON true
    LEFT JOIN public.profiles p ON p.id = a.changed_by
   WHERE e.farm_id = _farm_id AND e.active = true
     AND public.is_platform_staff(auth.uid())   -- cliente não lê esta lista
   ORDER BY e.name;
$$;
GRANT EXECUTE ON FUNCTION public.switching_protection_list(uuid) TO authenticated, service_role;

-- ============================================================================
-- CONFERÊNCIA
--   SELECT count(*) FROM public.equipments WHERE switching_protection_enabled;  -- 0
--   SELECT count(*) FROM public.equipments WHERE command_lock_until IS NOT NULL; -- 0
--   SELECT * FROM public.switching_protection_list('<farm>');
--   SELECT * FROM public.set_switching_protection('<equip>', true, 30);
-- ROLLBACK: SELECT public.set_switching_protection(id,false) para cada poço;
--           as colunas podem permanecer (inertes com false).
-- ============================================================================
