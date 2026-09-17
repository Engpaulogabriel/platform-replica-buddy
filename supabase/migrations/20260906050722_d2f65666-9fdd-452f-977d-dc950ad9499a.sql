-- ============================================================================
-- CENTRO DE EVIDÊNCIAS TÉCNICAS — FASE 1: INFRAESTRUTURA (20260905140000)
-- ============================================================================
CREATE TYPE public.tech_event_category AS ENUM (
  'internet', 'heartbeat', 'cloud', 'bridge', 'serial', 'radio', 'plc',
  'polling', 'automation', 'command', 'scheduler', 'watchdog',
  'communication', 'power', 'startup', 'shutdown', 'system'
);
CREATE TYPE public.tech_event_severity AS ENUM ('info', 'warning', 'error', 'critical');
CREATE TYPE public.tech_event_origin AS ENUM (
  'cloud', 'agent', 'plc', 'radio', 'scheduler', 'automation',
  'manual', 'local', 'unknown'
);

CREATE TABLE public.technical_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  farm_id          uuid NOT NULL REFERENCES public.farms(id) ON DELETE RESTRICT,
  equipment_id     uuid,
  gateway_id       text,
  event_type       text NOT NULL,
  category         public.tech_event_category NOT NULL,
  severity         public.tech_event_severity NOT NULL DEFAULT 'info',
  origin           public.tech_event_origin NOT NULL DEFAULT 'unknown',
  source           text,
  agent_version    text,
  platform_version text,
  correlation_id   uuid,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT technical_events_event_type_not_blank CHECK (btrim(event_type) <> ''),
  CONSTRAINT technical_events_payload_is_object  CHECK (jsonb_typeof(payload)  = 'object'),
  CONSTRAINT technical_events_metadata_is_object CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX technical_events_created_idx     ON public.technical_events (created_at DESC);
CREATE INDEX technical_events_farm_idx        ON public.technical_events (farm_id, created_at DESC);
CREATE INDEX technical_events_equipment_idx   ON public.technical_events (equipment_id, created_at DESC)
  WHERE equipment_id IS NOT NULL;
CREATE INDEX technical_events_category_idx    ON public.technical_events (category, created_at DESC);
CREATE INDEX technical_events_severity_idx    ON public.technical_events (severity, created_at DESC);
CREATE INDEX technical_events_event_type_idx  ON public.technical_events (event_type, created_at DESC);
CREATE INDEX technical_events_correlation_idx ON public.technical_events (correlation_id, created_at)
  WHERE correlation_id IS NOT NULL;
CREATE INDEX technical_events_farm_severity_idx
  ON public.technical_events (farm_id, severity, created_at DESC)
  WHERE severity IN ('error', 'critical');

COMMENT ON COLUMN public.technical_events.event_type IS
$doc$Catálogo previsto (texto livre; novos tipos não exigem migration):
 internet:      internet_online, internet_offline, internet_high_latency, internet_recovered
 heartbeat:     heartbeat_sent, heartbeat_missed, heartbeat_recovered
 startup:       agent_started, agent_restarted, agent_updated
 shutdown:      agent_stopped
 bridge:        bridge_connected, bridge_disconnected
 serial:        serial_port_opened, serial_port_closed, serial_failure
 plc:           plc_online, plc_offline
 polling:       polling_ok, polling_timeout
 radio:         radio_rssi_critical, radio_comm_lost, radio_comm_restored
 automation:    automatic_mode_started, automatic_mode_command_created,
                scheduled_shutdown_executed, peak_hour_executed
 command:       command_created, command_sent, command_responded,
                command_timeout, command_cancelled, command_executed
 watchdog:      safety_off, protective_off
 system:        exception, internal_failure$doc$;

CREATE OR REPLACE FUNCTION public.technical_events_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'technical_events é append-only e de retenção permanente: % não é permitido', TG_OP;
END $$;

CREATE TRIGGER technical_events_no_update BEFORE UPDATE ON public.technical_events
  FOR EACH ROW EXECUTE FUNCTION public.technical_events_append_only();
CREATE TRIGGER technical_events_no_delete BEFORE DELETE ON public.technical_events
  FOR EACH ROW EXECUTE FUNCTION public.technical_events_append_only();

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
  _metadata         jsonb   DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.technical_events (
    farm_id, equipment_id, gateway_id, event_type, category, severity, origin,
    source, agent_version, platform_version, correlation_id, payload, metadata
  ) VALUES (
    _farm_id, _equipment_id, _gateway_id, btrim(_event_type), _category, _severity, _origin,
    _source, _agent_version, _platform_version, _correlation_id,
    COALESCE(_payload, '{}'::jsonb), COALESCE(_metadata, '{}'::jsonb)
  ) RETURNING id INTO v_id;
  RETURN v_id;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END $$;

COMMENT ON FUNCTION public.record_technical_event IS
  'Único caminho de gravação do Centro de Evidências Técnicas. Nunca levanta exceção: devolve NULL em falha.';

ALTER TABLE public.technical_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.technical_events FROM PUBLIC, anon;
GRANT SELECT, INSERT ON public.technical_events TO authenticated;
GRANT ALL ON public.technical_events TO service_role;

REVOKE ALL ON FUNCTION public.record_technical_event(
  uuid, text, public.tech_event_category, public.tech_event_severity,
  public.tech_event_origin, uuid, text, text, text, text, uuid, jsonb, jsonb
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_technical_event(
  uuid, text, public.tech_event_category, public.tech_event_severity,
  public.tech_event_origin, uuid, text, text, text, text, uuid, jsonb, jsonb
) TO authenticated, service_role;

CREATE POLICY technical_events_read ON public.technical_events FOR SELECT TO authenticated
  USING (public.is_platform_admin(auth.uid()) OR public.has_farm_access(auth.uid(), farm_id));

CREATE POLICY technical_events_insert ON public.technical_events FOR INSERT TO authenticated
  WITH CHECK (public.is_platform_admin(auth.uid()));

COMMENT ON TABLE public.technical_events IS
  'Centro de Evidências Técnicas: trilha append-only, retenção PERMANENTE (sem purga/TTL). Só auditoria — não influencia acionamento.';