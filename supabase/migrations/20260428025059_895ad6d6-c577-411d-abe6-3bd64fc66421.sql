-- =====================================================
-- FASE 6: CONTROLE REMOTO DE FAZENDA
-- =====================================================

-- 1) Módulos opcionais como JSONB em farms
ALTER TABLE public.farms
  ADD COLUMN IF NOT EXISTS modules jsonb NOT NULL DEFAULT
    jsonb_build_object('vazao', false, 'consumo', false, 'ai_whatsapp', false);

-- 2) Tabela de mensagens da Renov ao operador
CREATE TABLE IF NOT EXISTS public.farm_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL,
  level text NOT NULL DEFAULT 'info', -- info | warning | critical
  title text NOT NULL,
  body text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  dismissed_by jsonb NOT NULL DEFAULT '[]'::jsonb -- array de user_ids que dispensaram
);

CREATE INDEX IF NOT EXISTS idx_farm_messages_farm
  ON public.farm_messages(farm_id, created_at DESC);

ALTER TABLE public.farm_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "farm_messages_select_members"
  ON public.farm_messages FOR SELECT
  TO authenticated
  USING (public.has_farm_access(auth.uid(), farm_id));

CREATE POLICY "farm_messages_select_platform_staff"
  ON public.farm_messages FOR SELECT
  TO authenticated
  USING (public.is_platform_staff(auth.uid()));

CREATE POLICY "farm_messages_update_members_dismiss"
  ON public.farm_messages FOR UPDATE
  TO authenticated
  USING (public.has_farm_access(auth.uid(), farm_id))
  WITH CHECK (public.has_farm_access(auth.uid(), farm_id));

-- =====================================================
-- RPCs DE CONTROLE REMOTO (Platform Admin)
-- =====================================================

-- Limpar fila de comandos travados
CREATE OR REPLACE FUNCTION public.platform_clear_pending_commands(_farm_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_cmd_count int := 0;
  v_agent_count int := 0;
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  UPDATE public.commands
    SET status = 'failed'::command_status,
        error_message = COALESCE(error_message, '') || ' [cleared by platform admin]'
    WHERE farm_id = _farm_id AND status = 'pending'::command_status;
  GET DIAGNOSTICS v_cmd_count = ROW_COUNT;

  UPDATE public.agent_commands
    SET status = 'expired'::agent_cmd_status,
        error_message = COALESCE(error_message, '') || ' [cleared by platform admin]'
    WHERE farm_id = _farm_id AND status IN ('pending'::agent_cmd_status, 'ack'::agent_cmd_status);
  GET DIAGNOSTICS v_agent_count = ROW_COUNT;

  RETURN jsonb_build_object(
    'commands_cleared', v_cmd_count,
    'agent_commands_cleared', v_agent_count
  );
END;
$$;

-- Forçar reboot do agente Electron
CREATE OR REPLACE FUNCTION public.platform_send_agent_reboot(_farm_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  INSERT INTO public.agent_commands (farm_id, kind, payload, created_by, expires_at)
  VALUES (
    _farm_id,
    'hard_reset_bridge'::agent_cmd_kind,
    jsonb_build_object('source', 'platform_admin', 'reason', 'remote_reboot'),
    auth.uid(),
    now() + interval '15 minutes'
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Enviar mensagem ao operador
CREATE OR REPLACE FUNCTION public.platform_send_farm_message(
  _farm_id uuid,
  _level text,
  _title text,
  _body text,
  _expires_at timestamptz DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;
  IF _level NOT IN ('info','warning','critical') THEN
    RAISE EXCEPTION 'invalid level';
  END IF;
  IF length(coalesce(_title,'')) < 2 OR length(coalesce(_body,'')) < 2 THEN
    RAISE EXCEPTION 'title and body required';
  END IF;

  INSERT INTO public.farm_messages (farm_id, level, title, body, created_by, expires_at)
  VALUES (_farm_id, _level, _title, _body, auth.uid(), _expires_at)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Atualizar módulos opcionais
CREATE OR REPLACE FUNCTION public.platform_set_farm_modules(
  _farm_id uuid,
  _modules jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new jsonb;
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  UPDATE public.farms
    SET modules = COALESCE(modules, '{}'::jsonb) || COALESCE(_modules, '{}'::jsonb),
        updated_at = now()
    WHERE id = _farm_id
  RETURNING modules INTO v_new;

  IF v_new IS NULL THEN
    RAISE EXCEPTION 'farm not found';
  END IF;

  RETURN v_new;
END;
$$;

-- Listar mensagens ativas para o operador atual (não expiradas, não dispensadas)
CREATE OR REPLACE FUNCTION public.farm_messages_active(_farm_id uuid)
RETURNS TABLE (
  id uuid,
  level text,
  title text,
  body text,
  created_at timestamptz,
  expires_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.id, m.level, m.title, m.body, m.created_at, m.expires_at
  FROM public.farm_messages m
  WHERE m.farm_id = _farm_id
    AND public.has_farm_access(auth.uid(), m.farm_id)
    AND (m.expires_at IS NULL OR m.expires_at > now())
    AND NOT (m.dismissed_by ? auth.uid()::text)
  ORDER BY
    CASE m.level WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
    m.created_at DESC;
$$;

-- Dispensar mensagem (operador)
CREATE OR REPLACE FUNCTION public.farm_messages_dismiss(_message_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_farm uuid;
BEGIN
  SELECT farm_id INTO v_farm FROM public.farm_messages WHERE id = _message_id;
  IF v_farm IS NULL THEN RETURN; END IF;
  IF NOT public.has_farm_access(auth.uid(), v_farm) THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  UPDATE public.farm_messages
    SET dismissed_by = CASE
      WHEN dismissed_by ? auth.uid()::text THEN dismissed_by
      ELSE dismissed_by || to_jsonb(auth.uid()::text)
    END
    WHERE id = _message_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.platform_clear_pending_commands(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_send_agent_reboot(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_send_farm_message(uuid, text, text, text, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_set_farm_modules(uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.farm_messages_active(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.farm_messages_dismiss(uuid) TO authenticated;