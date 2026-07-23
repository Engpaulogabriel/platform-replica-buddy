-- ─────────────────────────────────────────────────────────────────────────────
-- Etapa 2: Tabela commands + polling automático
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Enums
DO $$ BEGIN
  CREATE TYPE public.command_type AS ENUM ('polling', 'manual', 'config', 'server', 'repeater', 'diagnostic');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.command_status AS ENUM ('pending', 'sent', 'delivered', 'executed', 'timeout', 'error', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Adiciona 'polling' ao enum event_action existente (idempotente)
DO $$ BEGIN
  ALTER TYPE public.event_action ADD VALUE IF NOT EXISTS 'polling';
EXCEPTION WHEN others THEN NULL; END $$;

-- 2. Tabela commands
CREATE TABLE IF NOT EXISTS public.commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL,
  equipment_id uuid,
  plc_hw_id text,
  type public.command_type NOT NULL,
  status public.command_status NOT NULL DEFAULT 'pending',
  priority smallint NOT NULL DEFAULT 5,
  frame text NOT NULL,
  response text,
  error_message text,
  retry_count smallint NOT NULL DEFAULT 0,
  timeout_ms integer NOT NULL DEFAULT 10000,
  created_by uuid,
  source_device text,
  client_event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  responded_at timestamptz,
  CONSTRAINT commands_priority_chk CHECK (priority BETWEEN 1 AND 10)
);

-- Índices
CREATE INDEX IF NOT EXISTS commands_pending_queue_idx
  ON public.commands (farm_id, status, priority, created_at)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS commands_equipment_idx
  ON public.commands (equipment_id, created_at DESC);

CREATE INDEX IF NOT EXISTS commands_client_event_uniq
  ON public.commands (client_event_id);

-- 3. Polling fields em equipments
ALTER TABLE public.equipments
  ADD COLUMN IF NOT EXISTS polling_interval_seconds integer NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS last_polling_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_outputs_state text DEFAULT '000000';

-- 4. RLS
ALTER TABLE public.commands ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS commands_select_members ON public.commands;
CREATE POLICY commands_select_members
  ON public.commands FOR SELECT TO authenticated
  USING (public.has_farm_access(auth.uid(), farm_id));

DROP POLICY IF EXISTS commands_insert_operators ON public.commands;
CREATE POLICY commands_insert_operators
  ON public.commands FOR INSERT TO authenticated
  WITH CHECK (
    public.can_write_farm(auth.uid(), farm_id)
    AND (created_by IS NULL OR created_by = auth.uid())
  );

DROP POLICY IF EXISTS commands_update_admin ON public.commands;
CREATE POLICY commands_update_admin
  ON public.commands FOR UPDATE TO authenticated
  USING (public.is_farm_admin(auth.uid(), farm_id))
  WITH CHECK (public.is_farm_admin(auth.uid(), farm_id));

-- 5. Realtime
ALTER TABLE public.commands REPLICA IDENTITY FULL;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.commands;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 6. Função: enfileira polling para equipamentos vencidos
CREATE OR REPLACE FUNCTION public.enqueue_polling_for_due_equipments(_farm_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer := 0;
  v_eq RECORD;
  v_tsnn text;
  v_payload text;
  v_frame text;
BEGIN
  -- Verifica acesso
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissão para fazenda %', _farm_id;
  END IF;

  FOR v_eq IN
    SELECT e.id, e.hw_id, e.last_outputs_state, e.polling_interval_seconds, e.last_polling_at, pg.hw_id AS plc_hw_id
    FROM public.equipments e
    LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
    WHERE e.farm_id = _farm_id
      AND e.active = true
      AND e.type IN ('poco', 'bombeamento')
      AND (
        e.last_polling_at IS NULL
        OR e.last_polling_at < now() - (e.polling_interval_seconds || ' seconds')::interval
      )
      -- Evita duplicar: não enfileira se já existe pending para este equipamento
      AND NOT EXISTS (
        SELECT 1 FROM public.commands c
        WHERE c.equipment_id = e.id
          AND c.status = 'pending'
          AND c.type = 'polling'
      )
  LOOP
    v_tsnn := COALESCE(v_eq.plc_hw_id, substring(v_eq.hw_id from 1 for 4));
    v_payload := COALESCE(v_eq.last_outputs_state, '000000');
    v_frame := '[' || v_tsnn || '_1_]{' || v_payload || '}[' || v_tsnn || '_ETX_]' || E'\r';

    INSERT INTO public.commands (farm_id, equipment_id, plc_hw_id, type, priority, frame, timeout_ms, source_device)
    VALUES (_farm_id, v_eq.id, v_tsnn, 'polling', 5, v_frame, 10000, 'platform-scheduler');

    UPDATE public.equipments SET last_polling_at = now() WHERE id = v_eq.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

-- 7. Função: processa resposta de telemetria (chamada pelo Electron via cliente)
-- Recebe TSNN, payload de 6 dígitos, signal_bars (0-4) e atualiza equipments + commands
CREATE OR REPLACE FUNCTION public.apply_pump_telemetry(
  _farm_id uuid,
  _tsnn text,
  _payload text,
  _signal_bars smallint DEFAULT NULL,
  _command_id uuid DEFAULT NULL,
  _raw_response text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_eq_id uuid;
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissão para fazenda %', _farm_id;
  END IF;

  -- Atualiza todos os equipamentos do PLC (TSNN = primeiros 4 chars do hw_id)
  UPDATE public.equipments
  SET
    last_communication = now(),
    last_signal_bars = COALESCE(_signal_bars, last_signal_bars),
    last_outputs_state = _payload,
    updated_at = now()
  WHERE farm_id = _farm_id
    AND substring(hw_id from 1 for 4) = _tsnn
  RETURNING id INTO v_eq_id;

  -- Marca o comando como executed se foi passado
  IF _command_id IS NOT NULL THEN
    UPDATE public.commands
    SET status = 'executed',
        responded_at = now(),
        response = COALESCE(_raw_response, response)
    WHERE id = _command_id AND farm_id = _farm_id;
  END IF;

  RETURN v_eq_id;
END;
$$;

-- 8. Função: marca comando como timeout (chamada pelo worker)
CREATE OR REPLACE FUNCTION public.mark_commands_timeout(_farm_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissão para fazenda %', _farm_id;
  END IF;

  WITH updated AS (
    UPDATE public.commands
    SET status = 'timeout',
        responded_at = now(),
        error_message = 'Sem resposta dentro do timeout'
    WHERE farm_id = _farm_id
      AND status = 'sent'
      AND sent_at < now() - (timeout_ms || ' milliseconds')::interval
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM updated;

  RETURN COALESCE(v_count, 0);
END;
$$;