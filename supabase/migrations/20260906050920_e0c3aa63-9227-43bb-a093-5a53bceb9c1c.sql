-- ============================================================================
-- FASE 2D — HARDENING DA TRILHA FORENSE (20260906140000)
-- ============================================================================
DROP POLICY IF EXISTS device_licenses_select_farm_owner ON public.device_licenses;

CREATE OR REPLACE FUNCTION public.farm_device_status(_farm_id uuid)
RETURNS TABLE (
  device_id uuid, agent_version text, activated_at timestamptz,
  last_seen_at timestamptz, revoked boolean
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT dl.id, dl.agent_version, dl.activated_at, dl.last_seen_at,
         (dl.revoked_at IS NOT NULL)
    FROM public.device_licenses dl
   WHERE dl.farm_id = _farm_id
     AND (public.is_platform_staff(auth.uid())
          OR public.has_farm_role(auth.uid(), _farm_id, 'owner'::app_role));
$$;

REVOKE ALL ON FUNCTION public.farm_device_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.farm_device_status(uuid) TO authenticated;

DO $$
DECLARE v_dup int;
BEGIN
  SELECT count(*) INTO v_dup FROM (
    SELECT current_token_jti FROM public.device_licenses
     WHERE current_token_jti IS NOT NULL
     GROUP BY current_token_jti HAVING count(*) > 1) d;
  IF v_dup > 0 THEN
    RAISE EXCEPTION
      'ABORTADO: % jti(s) duplicados em device_licenses. Resolva antes (o jti é credencial bearer e não pode ser compartilhado).', v_dup;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS device_licenses_current_token_jti_uniq
  ON public.device_licenses (current_token_jti)
  WHERE current_token_jti IS NOT NULL;

CREATE TYPE public.tech_attestation_source AS ENUM
  ('agent', 'cloud', 'system', 'manual', 'imported');

ALTER TABLE public.technical_events
  ADD COLUMN IF NOT EXISTS attestation_source public.tech_attestation_source
  NOT NULL DEFAULT 'cloud';

CREATE INDEX IF NOT EXISTS technical_events_attestation_idx
  ON public.technical_events (attestation_source, created_at DESC);

COMMENT ON COLUMN public.technical_events.attestation_source IS
  'QUEM afirmou o evento. Definido server-side; nunca vem do corpo da requisição.';

DROP FUNCTION IF EXISTS public.record_technical_event(
  uuid, text, public.tech_event_category, public.tech_event_severity,
  public.tech_event_origin, uuid, text, text, text, text, uuid, jsonb, jsonb);

CREATE INDEX IF NOT EXISTS technical_events_ratelimit_idx
  ON public.technical_events (farm_id, event_type, created_at DESC);

CREATE OR REPLACE FUNCTION public.record_agent_technical_event(
  _agent_jti        uuid,
  _event_type       text,
  _category         public.tech_event_category,
  _severity         public.tech_event_severity DEFAULT 'info',
  _origin           public.tech_event_origin   DEFAULT 'agent',
  _equipment_id     uuid    DEFAULT NULL,
  _gateway_id       text    DEFAULT NULL,
  _agent_version    text    DEFAULT NULL,
  _correlation_id   uuid    DEFAULT NULL,
  _payload          jsonb   DEFAULT '{}'::jsonb,
  _metadata         jsonb   DEFAULT '{}'::jsonb,
  _client_event_id  uuid    DEFAULT NULL,
  _occurred_at      timestamptz DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_farm uuid; v_id uuid; v_recent int; v_same int;
  v_disc text := COALESCE(_gateway_id, _equipment_id::text, '');
BEGIN
  SELECT dl.farm_id INTO v_farm
    FROM public.device_licenses dl
   WHERE dl.current_token_jti = _agent_jti::text
     AND dl.revoked_at IS NULL
     AND dl.current_token_expires_at IS NOT NULL
     AND dl.current_token_expires_at > now()
   LIMIT 1;
  IF v_farm IS NULL THEN RETURN NULL; END IF;

  IF _event_type IS NULL OR btrim(_event_type) = '' OR length(_event_type) > 120 THEN
    RETURN NULL;
  END IF;
  IF length(COALESCE(_payload,'{}')::text)  > 8192 THEN RETURN NULL; END IF;
  IF length(COALESCE(_metadata,'{}')::text) > 2048 THEN RETURN NULL; END IF;
  IF jsonb_typeof(COALESCE(_payload,'{}'))  <> 'object' THEN RETURN NULL; END IF;
  IF jsonb_typeof(COALESCE(_metadata,'{}')) <> 'object' THEN RETURN NULL; END IF;

  SELECT count(*) INTO v_recent
    FROM public.technical_events te
   WHERE te.farm_id = v_farm AND te.created_at > now() - interval '1 minute';
  IF v_recent >= 120 THEN RETURN NULL; END IF;

  SELECT count(*) INTO v_same
    FROM public.technical_events te
   WHERE te.farm_id = v_farm
     AND te.event_type = btrim(_event_type)
     AND COALESCE(te.gateway_id, te.equipment_id::text, '') = v_disc
     AND te.created_at > now() - interval '1 minute';
  IF v_same >= 10 THEN RETURN NULL; END IF;

  INSERT INTO public.technical_events (
    farm_id, equipment_id, gateway_id, event_type, category, severity, origin,
    source, agent_version, correlation_id, payload, metadata,
    client_event_id, created_at, attestation_source
  ) VALUES (
    v_farm, _equipment_id, _gateway_id, btrim(_event_type), _category, _severity, _origin,
    'agent', _agent_version, _correlation_id,
    COALESCE(_payload,'{}'::jsonb), COALESCE(_metadata,'{}'::jsonb),
    _client_event_id, COALESCE(_occurred_at, now()),
    'agent'::public.tech_attestation_source
  )
  ON CONFLICT (client_event_id) WHERE client_event_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.record_agent_technical_event(
  uuid, text, public.tech_event_category, public.tech_event_severity,
  public.tech_event_origin, uuid, text, text, uuid, jsonb, jsonb, uuid, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_agent_technical_event(
  uuid, text, public.tech_event_category, public.tech_event_severity,
  public.tech_event_origin, uuid, text, text, uuid, jsonb, jsonb, uuid, timestamptz
) TO anon, authenticated, service_role;