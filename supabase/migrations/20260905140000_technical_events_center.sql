-- ============================================================================
-- CENTRO DE EVIDÊNCIAS TÉCNICAS — FASE 1: INFRAESTRUTURA
-- ----------------------------------------------------------------------------
-- Trilha técnica PERMANENTE para auditoria e forense de incidentes. Sem
-- interface, sem integração com Agent/Edge Functions nesta fase.
--
-- POR QUE UMA TABELA NOVA, e não `agent_technical_events`:
--   A existente tem apenas (kind, details, occurred_at) — sem severidade,
--   categoria, origem, correlação nem versões — e, decisivo, tem
--   `purge_agent_technical_events(_keep interval DEFAULT '30 days')`. Evidência
--   forense com purga de 30 dias não serve: a investigação da SOSSEGO mostrou
--   que a retenção curta é justamente o que inviabiliza a reconstrução.
--   Esta tabela NÃO tem purga, NÃO tem TTL e NÃO aceita DELETE.
--
-- BARREIRA: isto é AUDITORIA. Nada aqui lê ou escreve `commands`, `equipments`,
--   `desired_running`, `pending_command_id`, `automation_*` ou `scheduled_*`.
--   Gravar evento NÃO pode bloquear comando, alterar intenção nem influenciar
--   acionamento. Há teste que falha se qualquer um desses símbolos aparecer.
--
-- NOMES: enums com prefixo `tech_` porque `event_origin` já existe no projeto
--   (cadeia de autoria do Relatório) e tem outro significado.
-- ============================================================================

-- ── ENUMS ──────────────────────────────────────────────────────────────────
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

-- ── TABELA ─────────────────────────────────────────────────────────────────
CREATE TABLE public.technical_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  farm_id          uuid NOT NULL REFERENCES public.farms(id) ON DELETE RESTRICT,
  -- Nullable: evento de infraestrutura (internet, bridge, agente) não pertence
  -- a um equipamento específico.
  equipment_id     uuid,
  -- Texto, não FK: o gateway/PLC é identificado pelo TSNN, que não tem tabela
  -- própria com chave estável em todas as fazendas.
  gateway_id       text,
  event_type       text NOT NULL,
  category         public.tech_event_category NOT NULL,
  severity         public.tech_event_severity NOT NULL DEFAULT 'info',
  origin           public.tech_event_origin NOT NULL DEFAULT 'unknown',
  -- Quem emitiu: 'agent', 'automation-tick', 'critical-alerts-tick', 'web'...
  source           text,
  agent_version    text,
  platform_version text,
  -- Agrupa os eventos de UM incidente: heartbeat perdido → internet offline →
  -- PLC offline → timeout de polling → recuperação compartilham o mesmo id.
  correlation_id   uuid,
  payload          jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT technical_events_event_type_not_blank CHECK (btrim(event_type) <> ''),
  CONSTRAINT technical_events_payload_is_object  CHECK (jsonb_typeof(payload)  = 'object'),
  CONSTRAINT technical_events_metadata_is_object CHECK (jsonb_typeof(metadata) = 'object')
);
-- `equipment_id` é uuid SEM FK, de propósito, e a razão é concreta: com
-- append-only, qualquer FK aqui trava a exclusão do equipamento — ON DELETE
-- SET NULL viraria um UPDATE que o trigger bloqueia, e RESTRICT/NO ACTION
-- barraria o DELETE. O resultado seria "não é mais possível excluir um
-- equipamento que já gerou evento técnico". Guardar o id solto preserva a
-- evidência E mantém a exclusão possível; um equipamento apagado deixa o id
-- órfão, que continua sendo o dado forense correto (era ELE que estava lá).
-- `farm_id` mantém FK RESTRICT: apagar fazenda com histórico forense tem de ser
-- decisão explícita, não efeito colateral.

-- ── ÍNDICES ────────────────────────────────────────────────────────────────
CREATE INDEX technical_events_created_idx     ON public.technical_events (created_at DESC);
CREATE INDEX technical_events_farm_idx        ON public.technical_events (farm_id, created_at DESC);
CREATE INDEX technical_events_equipment_idx   ON public.technical_events (equipment_id, created_at DESC)
  WHERE equipment_id IS NOT NULL;
CREATE INDEX technical_events_category_idx    ON public.technical_events (category, created_at DESC);
CREATE INDEX technical_events_severity_idx    ON public.technical_events (severity, created_at DESC);
CREATE INDEX technical_events_event_type_idx  ON public.technical_events (event_type, created_at DESC);
CREATE INDEX technical_events_correlation_idx ON public.technical_events (correlation_id, created_at)
  WHERE correlation_id IS NOT NULL;
-- Índice de investigação: "o que aconteceu de grave nesta fazenda no período".
CREATE INDEX technical_events_farm_severity_idx
  ON public.technical_events (farm_id, severity, created_at DESC)
  WHERE severity IN ('error', 'critical');

-- ── CATÁLOGO DE event_type ─────────────────────────────────────────────────
-- Documentação viva, não constraint: `event_type` é texto livre de propósito,
-- para que uma integração futura possa registrar um tipo novo sem migration —
-- perder evidência por falta de enum seria pior do que um tipo fora do catálogo.
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

-- ── APPEND-ONLY / RETENÇÃO PERMANENTE ──────────────────────────────────────
-- Sem purga, sem TTL, sem rotina de limpeza. UPDATE e DELETE bloqueados por
-- trigger E por privilégio: evidência forense que pode ser editada não é
-- evidência. Ver o incidente da SOSSEGO, em que a retenção de 48h de `commands`
-- inviabilizou a reconstrução.
CREATE OR REPLACE FUNCTION public.technical_events_append_only()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  RAISE EXCEPTION 'technical_events é append-only e de retenção permanente: % não é permitido', TG_OP;
END $$;

CREATE TRIGGER technical_events_no_update BEFORE UPDATE ON public.technical_events
  FOR EACH ROW EXECUTE FUNCTION public.technical_events_append_only();
CREATE TRIGGER technical_events_no_delete BEFORE DELETE ON public.technical_events
  FOR EACH ROW EXECUTE FUNCTION public.technical_events_append_only();

-- ── HELPER ÚNICO DE GRAVAÇÃO ───────────────────────────────────────────────
-- ÚNICO caminho de escrita. Agent, Edge Functions e frontend passam por aqui;
-- nenhum INSERT direto espalhado pelo código.
--
-- NUNCA LEVANTA EXCEÇÃO: auditoria não pode derrubar quem a chama. Se a
-- gravação falhar, devolve NULL e a operação segue. Um evento perdido é ruim;
-- um comando de bomba que falha porque o log falhou é inaceitável.
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
  RETURN NULL;   -- auditoria nunca derruba a operação
END $$;

COMMENT ON FUNCTION public.record_technical_event IS
  'Único caminho de gravação do Centro de Evidências Técnicas. Nunca levanta exceção: devolve NULL em falha.';

-- ── RLS E GRANTS ───────────────────────────────────────────────────────────
ALTER TABLE public.technical_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.technical_events FROM PUBLIC, anon;
-- Sem UPDATE e sem DELETE nem no nível de privilégio: retenção permanente
-- deixa de depender só do trigger.
GRANT SELECT, INSERT ON public.technical_events TO authenticated;

REVOKE ALL ON FUNCTION public.record_technical_event(
  uuid, text, public.tech_event_category, public.tech_event_severity,
  public.tech_event_origin, uuid, text, text, text, text, uuid, jsonb, jsonb
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_technical_event(
  uuid, text, public.tech_event_category, public.tech_event_severity,
  public.tech_event_origin, uuid, text, text, text, text, uuid, jsonb, jsonb
) TO authenticated, service_role;

-- Leitura: admin da plataforma vê tudo; usuário da fazenda vê a própria.
-- `has_farm_access` já é o padrão do projeto para esse recorte.
CREATE POLICY technical_events_read ON public.technical_events FOR SELECT TO authenticated
  USING (public.is_platform_admin(auth.uid()) OR public.has_farm_access(auth.uid(), farm_id));

-- Escrita direta só do admin da plataforma; o caminho normal é a RPC
-- SECURITY DEFINER acima.
CREATE POLICY technical_events_insert ON public.technical_events FOR INSERT TO authenticated
  WITH CHECK (public.is_platform_admin(auth.uid()));

COMMENT ON TABLE public.technical_events IS
  'Centro de Evidências Técnicas: trilha append-only, retenção PERMANENTE (sem purga/TTL). Só auditoria — não influencia acionamento.';
