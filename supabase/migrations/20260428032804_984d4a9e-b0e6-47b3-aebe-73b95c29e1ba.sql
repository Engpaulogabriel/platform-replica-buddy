
-- ============================================================
-- 1) PROVISIONING TOKENS (one-shot, 30d, embutido no agente)
-- ============================================================
CREATE TABLE public.provisioning_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days'),
  consumed_at TIMESTAMPTZ,
  consumed_by_machine_hash TEXT,
  consumed_ip TEXT,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,
  notes TEXT
);

CREATE INDEX idx_provisioning_tokens_farm ON public.provisioning_tokens(farm_id);
CREATE INDEX idx_provisioning_tokens_active ON public.provisioning_tokens(token) WHERE consumed_at IS NULL AND revoked_at IS NULL;

ALTER TABLE public.provisioning_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "provisioning_tokens_select_platform_staff"
  ON public.provisioning_tokens FOR SELECT TO authenticated
  USING (is_platform_staff(auth.uid()));

CREATE POLICY "provisioning_tokens_select_farm_owner"
  ON public.provisioning_tokens FOR SELECT TO authenticated
  USING (has_farm_role(auth.uid(), farm_id, 'owner'::app_role));

-- ============================================================
-- 2) AGENT CREDENTIALS (1 user automático por fazenda)
-- ============================================================
CREATE TABLE public.agent_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL UNIQUE REFERENCES public.farms(id) ON DELETE CASCADE,
  auth_user_id UUID NOT NULL,
  email TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ,
  rotated_at TIMESTAMPTZ
);

ALTER TABLE public.agent_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_credentials_select_platform_staff"
  ON public.agent_credentials FOR SELECT TO authenticated
  USING (is_platform_staff(auth.uid()));

CREATE POLICY "agent_credentials_select_farm_owner"
  ON public.agent_credentials FOR SELECT TO authenticated
  USING (has_farm_role(auth.uid(), farm_id, 'owner'::app_role));

-- ============================================================
-- 3) TAMPERING EVENTS (mexidas detectadas no agente)
-- ============================================================
CREATE TYPE public.tampering_kind AS ENUM (
  'asar_modified',
  'hardware_changed',
  'config_replaced',
  'integrity_check_failed',
  'unsigned_binary',
  'other'
);

CREATE TYPE public.tampering_level AS ENUM ('info', 'warn', 'critical');

CREATE TABLE public.tampering_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id UUID NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  device_license_id UUID REFERENCES public.device_licenses(id) ON DELETE SET NULL,
  kind tampering_kind NOT NULL,
  level tampering_level NOT NULL DEFAULT 'warn',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  expected_hash TEXT,
  actual_hash TEXT,
  agent_version TEXT,
  reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID,
  action_taken TEXT
);

CREATE INDEX idx_tampering_events_farm ON public.tampering_events(farm_id, reported_at DESC);
CREATE INDEX idx_tampering_events_unack ON public.tampering_events(reported_at DESC) WHERE acknowledged_at IS NULL;

ALTER TABLE public.tampering_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tampering_events_select_platform_staff"
  ON public.tampering_events FOR SELECT TO authenticated
  USING (is_platform_staff(auth.uid()));

CREATE POLICY "tampering_events_select_farm_owner"
  ON public.tampering_events FOR SELECT TO authenticated
  USING (has_farm_role(auth.uid(), farm_id, 'owner'::app_role));

CREATE POLICY "tampering_events_update_platform_admin"
  ON public.tampering_events FOR UPDATE TO authenticated
  USING (is_platform_admin(auth.uid()))
  WITH CHECK (is_platform_admin(auth.uid()));

-- ============================================================
-- 4) RPC: Gerar token de provisionamento (admin only)
-- ============================================================
CREATE OR REPLACE FUNCTION public.platform_generate_provisioning_token(
  _farm_id UUID,
  _notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_token TEXT;
  v_id UUID;
  v_farm_name TEXT;
  v_license_key TEXT;
BEGIN
  IF NOT is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Apenas administradores da plataforma podem gerar tokens de provisionamento';
  END IF;

  SELECT name, license_key INTO v_farm_name, v_license_key
  FROM farms WHERE id = _farm_id;

  IF v_farm_name IS NULL THEN
    RAISE EXCEPTION 'Fazenda não encontrada';
  END IF;

  -- Token formato: PROV-XXXX-XXXX-XXXX-XXXX (20 chars úteis, hex maiúsculo)
  v_token := 'PROV-' ||
    upper(substr(encode(gen_random_bytes(2), 'hex'), 1, 4)) || '-' ||
    upper(substr(encode(gen_random_bytes(2), 'hex'), 1, 4)) || '-' ||
    upper(substr(encode(gen_random_bytes(2), 'hex'), 1, 4)) || '-' ||
    upper(substr(encode(gen_random_bytes(2), 'hex'), 1, 4));

  INSERT INTO provisioning_tokens (farm_id, token, created_by, notes)
  VALUES (_farm_id, v_token, auth.uid(), _notes)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object(
    'id', v_id,
    'token', v_token,
    'farm_id', _farm_id,
    'farm_name', v_farm_name,
    'license_key', v_license_key,
    'expires_at', (now() + INTERVAL '30 days'),
    'provisioning_json', jsonb_build_object(
      'version', 1,
      'farm_id', _farm_id,
      'farm_name', v_farm_name,
      'provisioning_token', v_token,
      'license_key', v_license_key,
      'issued_at', now(),
      'expires_at', (now() + INTERVAL '30 days')
    )
  );
END;
$$;

-- ============================================================
-- 5) RPC: Revogar token antes do uso (admin only)
-- ============================================================
CREATE OR REPLACE FUNCTION public.platform_revoke_provisioning_token(
  _token_id UUID,
  _reason TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Apenas administradores podem revogar tokens';
  END IF;

  UPDATE provisioning_tokens
  SET revoked_at = now(),
      revoked_reason = COALESCE(_reason, 'Revogado pelo admin')
  WHERE id = _token_id
    AND consumed_at IS NULL
    AND revoked_at IS NULL;

  RETURN FOUND;
END;
$$;

-- ============================================================
-- 6) RPC: Ack tampering event (admin)
-- ============================================================
CREATE OR REPLACE FUNCTION public.acknowledge_tampering_event(
  _event_id UUID,
  _action_taken TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Apenas administradores podem reconhecer eventos';
  END IF;

  UPDATE tampering_events
  SET acknowledged_at = now(),
      acknowledged_by = auth.uid(),
      action_taken = _action_taken
  WHERE id = _event_id
    AND acknowledged_at IS NULL;

  RETURN FOUND;
END;
$$;
