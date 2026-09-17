-- ============================================================================
-- INGESTÃO DIRETA AGENT → POSTGREST (20260906120000)
-- ============================================================================
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
  v_farm uuid;
  v_id   uuid;
  v_recent int;
BEGIN
  SELECT dl.farm_id INTO v_farm
    FROM public.device_licenses dl
   WHERE dl.current_token_jti = _agent_jti::text
     AND dl.revoked_at IS NULL
     AND (dl.current_token_expires_at IS NULL OR dl.current_token_expires_at > now())
   LIMIT 1;
  IF v_farm IS NULL THEN
    RETURN NULL;
  END IF;

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

  INSERT INTO public.technical_events (
    farm_id, equipment_id, gateway_id, event_type, category, severity, origin,
    source, agent_version, correlation_id, payload, metadata,
    client_event_id, created_at
  ) VALUES (
    v_farm, _equipment_id, _gateway_id, btrim(_event_type), _category, _severity, _origin,
    'agent', _agent_version, _correlation_id,
    COALESCE(_payload,'{}'::jsonb), COALESCE(_metadata,'{}'::jsonb),
    _client_event_id, COALESCE(_occurred_at, now())
  )
  ON CONFLICT (client_event_id) WHERE client_event_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END $$;

COMMENT ON FUNCTION public.record_agent_technical_event IS
  'Ingestão direta Agent -> technical_events. Autentica por device_licenses.current_token_jti; farm_id derivado da licença (não há parâmetro de fazenda). Sem Edge Function.';

REVOKE ALL ON FUNCTION public.record_agent_technical_event(
  uuid, text, public.tech_event_category, public.tech_event_severity,
  public.tech_event_origin, uuid, text, text, uuid, jsonb, jsonb, uuid, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_agent_technical_event(
  uuid, text, public.tech_event_category, public.tech_event_severity,
  public.tech_event_origin, uuid, text, text, uuid, jsonb, jsonb, uuid, timestamptz
) TO anon, authenticated, service_role;

ALTER TABLE public.technical_events REPLICA IDENTITY FULL;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.technical_events;
EXCEPTION WHEN duplicate_object THEN NULL;
         WHEN undefined_object THEN NULL;
END $$;