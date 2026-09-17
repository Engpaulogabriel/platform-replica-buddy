-- ============================================================================
-- FASE 2 — IDEMPOTÊNCIA DA INGESTÃO (20260905160000)
-- ============================================================================
ALTER TABLE public.technical_events
  ADD COLUMN IF NOT EXISTS client_event_id uuid;

COMMENT ON COLUMN public.technical_events.client_event_id IS
  'UUID gerado no Agent no momento do evento. Chave de deduplicação de retry/flush.';

CREATE UNIQUE INDEX IF NOT EXISTS technical_events_client_event_uniq
  ON public.technical_events (client_event_id)
  WHERE client_event_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.record_technical_event(
  _farm_id          uuid,
  _event_type       text,
  _category         public.tech_event_category,
  _severity         public.tech_event_severity DEFAULT 'info',
  _origin           public.tech_event_origin   DEFAULT 'unknown',
  _equipment_id     uuid    DEFAULT NULL,
  _gateway_id       text    DEFAULT NULL,
  _source           text    DEFAULT NULL,
  _agent_version    text    DEFAULT NULL,
  _platform_version text    DEFAULT NULL,
  _correlation_id   uuid    DEFAULT NULL,
  _payload          jsonb   DEFAULT '{}'::jsonb,
  _metadata         jsonb   DEFAULT '{}'::jsonb,
  _client_event_id  uuid    DEFAULT NULL,
  _occurred_at      timestamptz DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.technical_events (
    farm_id, equipment_id, gateway_id, event_type, category, severity, origin,
    source, agent_version, platform_version, correlation_id, payload, metadata,
    client_event_id, created_at
  ) VALUES (
    _farm_id, _equipment_id, _gateway_id, btrim(_event_type), _category, _severity, _origin,
    _source, _agent_version, _platform_version, _correlation_id,
    COALESCE(_payload, '{}'::jsonb), COALESCE(_metadata, '{}'::jsonb),
    _client_event_id, COALESCE(_occurred_at, now())
  )
  ON CONFLICT (client_event_id) WHERE client_event_id IS NOT NULL DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END $$;

REVOKE ALL ON FUNCTION public.record_technical_event(
  uuid, text, public.tech_event_category, public.tech_event_severity,
  public.tech_event_origin, uuid, text, text, text, text, uuid, jsonb, jsonb,
  uuid, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_technical_event(
  uuid, text, public.tech_event_category, public.tech_event_severity,
  public.tech_event_origin, uuid, text, text, text, text, uuid, jsonb, jsonb,
  uuid, timestamptz) TO authenticated, service_role;