-- ============================================================================
-- INGESTÃO DIRETA AGENT → POSTGREST (sem Edge Function, sem Lovable Cloud)
-- ----------------------------------------------------------------------------
-- POR QUE NÃO VALIDAR HS256 AQUI
--   Validar a assinatura em SQL exigiria AGENT_TOKEN_SECRET no Vault,
--   decodificação base64url manual e comparação de HMAC não-constante — mais
--   segredo no banco e mais superfície.
--
--   E seria REDUNDANTE. O `jti` é um UUIDv4 (122 bits de entropia) gerado por
--   `agent-auth` e materializado em `device_licenses.current_token_jti`. Ele
--   VIVE DENTRO do token: quem tem um jti válido tem o token. E nenhuma claim
--   do token é confiada — `farm_id` vem da LINHA da licença, encontrada pelo
--   jti. Um token adulterado com outro farm_id continua resolvendo para a
--   licença do jti apresentado. Forjar assinatura não compra nada.
--
--   Validade e revogação também vêm do BANCO (`current_token_expires_at`,
--   `revoked_at`), não do `exp` do token — a fonte autoritativa é a linha, e
--   revogar passa a ter efeito imediato, sem esperar o token expirar.
--
--   `agent-auth` rotaciona o jti a cada ~10 min; um jti antigo deixa de casar.
--   Clone detectado → `agent-auth` troca o jti → o clone é cortado aqui também.
--
-- NÃO abre INSERT direto: `technical_events` continua sem policy de INSERT para
-- anon. O ÚNICO caminho é esta função SECURITY DEFINER.
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
  -- ── AUTENTICAÇÃO ─────────────────────────────────────────────────────────
  -- farm_id DERIVADO da licença. Não existe parâmetro de fazenda nesta função:
  -- falsificar a fazenda é impossível porque não há onde informá-la.
  SELECT dl.farm_id INTO v_farm
    FROM public.device_licenses dl
   WHERE dl.current_token_jti = _agent_jti::text
     AND dl.revoked_at IS NULL
     AND (dl.current_token_expires_at IS NULL OR dl.current_token_expires_at > now())
   LIMIT 1;
  IF v_farm IS NULL THEN
    RETURN NULL;   -- jti inválido/expirado/revogado: silencioso, não vaza motivo
  END IF;

  -- ── LIMITES ──────────────────────────────────────────────────────────────
  IF _event_type IS NULL OR btrim(_event_type) = '' OR length(_event_type) > 120 THEN
    RETURN NULL;
  END IF;
  IF length(COALESCE(_payload,'{}')::text)  > 8192 THEN RETURN NULL; END IF;
  IF length(COALESCE(_metadata,'{}')::text) > 2048 THEN RETURN NULL; END IF;
  IF jsonb_typeof(COALESCE(_payload,'{}'))  <> 'object' THEN RETURN NULL; END IF;
  IF jsonb_typeof(COALESCE(_metadata,'{}')) <> 'object' THEN RETURN NULL; END IF;

  -- ── RATE LIMIT ───────────────────────────────────────────────────────────
  -- Teto por fazenda/minuto. Fazenda saudável grava ~0/dia; 120/min é folga
  -- enorme para um flush de buffer e ainda contém agente em laço.
  SELECT count(*) INTO v_recent
    FROM public.technical_events te
   WHERE te.farm_id = v_farm AND te.created_at > now() - interval '1 minute';
  IF v_recent >= 120 THEN RETURN NULL; END IF;

  -- ── GRAVAÇÃO ─────────────────────────────────────────────────────────────
  -- occurred_at REAL do campo: o buffer entrega minutos depois, e gravar a hora
  -- do upload destruiria a linha do tempo do incidente.
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
  RETURN v_id;   -- NULL em duplicata: reenvio é no-op
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;   -- auditoria nunca derruba a operação do Agent
END $$;

COMMENT ON FUNCTION public.record_agent_technical_event IS
  'Ingestão direta Agent -> technical_events. Autentica por device_licenses.current_token_jti; farm_id derivado da licença (não há parâmetro de fazenda). Sem Edge Function.';

-- O Agent conecta com a ANON key: ela precisa poder EXECUTAR. A autorização
-- real é o jti, não o papel. `technical_events` continua SEM policy de INSERT
-- para anon — esta função é o único caminho.
REVOKE ALL ON FUNCTION public.record_agent_technical_event(
  uuid, text, public.tech_event_category, public.tech_event_severity,
  public.tech_event_origin, uuid, text, text, uuid, jsonb, jsonb, uuid, timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.record_agent_technical_event(
  uuid, text, public.tech_event_category, public.tech_event_severity,
  public.tech_event_origin, uuid, text, text, uuid, jsonb, jsonb, uuid, timestamptz
) TO anon, authenticated, service_role;

-- ── REALTIME ───────────────────────────────────────────────────────────────
-- A interface técnica futura recebe evento novo por push, sem polling.
-- REPLICA IDENTITY FULL para o payload do Realtime trazer a linha inteira.
ALTER TABLE public.technical_events REPLICA IDENTITY FULL;
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.technical_events;
EXCEPTION WHEN duplicate_object THEN NULL;
         WHEN undefined_object THEN NULL;  -- publicação ausente em ambiente local
END $$;
