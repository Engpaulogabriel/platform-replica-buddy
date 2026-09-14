-- ============================================================================
-- FASE 2D — HARDENING DA TRILHA FORENSE
-- ----------------------------------------------------------------------------
-- Leva o modelo de "A) telemetria operacional" para "B) evidência técnica forte".
--
-- O PROBLEMA CENTRAL: `device_licenses_select_farm_owner` deixava o DONO DA
-- FAZENDA ler a linha inteira — incluindo `current_token_jti`, que é a
-- credencial bearer da ingestão técnica. O cliente cujo incidente estamos
-- investigando podia ler o jti do próprio agente e forjar eventos na própria
-- trilha. Para telemetria isso é irrelevante; para provar um evento AO CLIENTE
-- é discvalificante.
-- ============================================================================

-- ── 1) O JTI SAI DA VISTA DO CLIENTE ───────────────────────────────────────
-- Por que DROP e não coluna mascarada: RLS é row-level, não column-level, e
-- privilégio de coluna é por PAPEL — não distingue "owner" de "platform staff",
-- que autenticam com o mesmo papel `authenticated`. A separação correta é por
-- FUNÇÃO.
--
-- Verificado antes: o frontend só lê `device_licenses` em componentes de
-- PLATAFORMA (PlatformDevices, PlatformRemoteControl), cobertos pela policy de
-- staff. Nenhum consumo como owner — o DROP não quebra tela nenhuma.
DROP POLICY IF EXISTS device_licenses_select_farm_owner ON public.device_licenses;

-- O dono continua vendo o que lhe interessa, por RPC, SEM campo sensível.
-- Ficam de fora: current_token_jti, current_token_expires_at, fingerprint,
-- license_key, machine_id_hash, ip_address.
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

-- ── 2) UNIQUE NO JTI ───────────────────────────────────────────────────────
-- Duas licenças jamais podem compartilhar a mesma credencial bearer. Aborta com
-- mensagem clara se já houver duplicata, em vez de falhar no CREATE INDEX.
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

-- ── 3) PROCEDÊNCIA DO EVENTO ───────────────────────────────────────────────
-- O relatório precisa distinguir "o Agent afirmou" de "a Cloud afirmou".
CREATE TYPE public.tech_attestation_source AS ENUM
  ('agent', 'cloud', 'system', 'manual', 'imported');

ALTER TABLE public.technical_events
  ADD COLUMN IF NOT EXISTS attestation_source public.tech_attestation_source
  NOT NULL DEFAULT 'cloud';
-- Default 'cloud': o que entra por `record_technical_event` (caminho servidor)
-- não é afirmação do Agent. Só a RPC do Agent grava 'agent', e ela o faz
-- server-side — não há parâmetro para isso.

CREATE INDEX IF NOT EXISTS technical_events_attestation_idx
  ON public.technical_events (attestation_source, created_at DESC);

COMMENT ON COLUMN public.technical_events.attestation_source IS
  'QUEM afirmou o evento. Definido server-side; nunca vem do corpo da requisição.';

-- ── 3b) SOBRECARGA AMBÍGUA DE record_technical_event ───────────────────────
-- DEFEITO REAL: a migration 20260905160000 usou CREATE OR REPLACE ACRESCENTANDO
-- parâmetros (`_client_event_id`, `_occurred_at`). Em Postgres isso cria uma
-- SOBRECARGA NOVA, não substitui a anterior. Com as duas assinaturas vivas e
-- todos os parâmetros extras com DEFAULT, qualquer chamada curta falha com
-- "function ... is not unique" — inclusive a que a Edge/Cloud usa.
-- Removida a versão antiga (13 parâmetros); fica só a de 15.
DROP FUNCTION IF EXISTS public.record_technical_event(
  uuid, text, public.tech_event_category, public.tech_event_severity,
  public.tech_event_origin, uuid, text, text, text, text, uuid, jsonb, jsonb);

-- ── 4 e 5) RPC DO AGENT ENDURECIDA ─────────────────────────────────────────
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
  -- AUTENTICAÇÃO. Não há parâmetro de fazenda: falsificar farm_id é impossível
  -- porque não existe onde informá-lo.
  -- EXPIRAÇÃO OBRIGATÓRIA: NULL é INVÁLIDO. Antes, `IS NULL OR > now()` fazia
  -- uma linha sem validade nunca expirar — credencial eterna por omissão.
  SELECT dl.farm_id INTO v_farm
    FROM public.device_licenses dl
   WHERE dl.current_token_jti = _agent_jti::text
     AND dl.revoked_at IS NULL
     AND dl.current_token_expires_at IS NOT NULL
     AND dl.current_token_expires_at > now()
   LIMIT 1;
  IF v_farm IS NULL THEN
    RETURN NULL;   -- inválido/expirado/revogado/sem validade: silencioso
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
    client_event_id, created_at, attestation_source
  ) VALUES (
    v_farm, _equipment_id, _gateway_id, btrim(_event_type), _category, _severity, _origin,
    'agent', _agent_version, _correlation_id,
    COALESCE(_payload,'{}'::jsonb), COALESCE(_metadata,'{}'::jsonb),
    _client_event_id, COALESCE(_occurred_at, now()),
    -- SERVER-SIDE, literal. Não há parâmetro: forjar procedência é impossível.
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

-- ── 6) RATE LIMIT POR TIPO — com discriminador de origem ───────────────────
-- POR QUE NÃO 10/min POR (farm_id, event_type) E PRONTO:
--   `plc_offline` é emitido POR TSNN, em `noteBackoffFailure`, quando aquela
--   PLC acumula 3 falhas consecutivas. Numa perda TOTAL de comunicação, todas
--   as PLCs da fazenda cruzam o limiar quase juntas. Numa fazenda com mais de
--   10 PLCs, um teto de 10/min por tipo DESCARTARIA evidência exatamente no
--   incidente que mais precisamos reconstruir — o teto viraria censura.
--
--   A correção é o DISCRIMINADOR: o teto é por PLC/equipamento, não por tipo.
--   Cada TSNN tem seu próprio orçamento; 30 PLCs caindo juntas geram 30 linhas
--   legítimas, e uma PLC em laço continua contida em 10/min.
--
-- FOLGA PARA OS TIPOS SEM DISCRIMINADOR (internet_*, cloud_*, bridge_*,
-- agent_started): a histerese exige 3 sondagens falhas a 60s = 3 min entre
-- transições. O máximo legítimo é ~1 a cada 3 min. 10/min é 30× de folga.
--
-- O teto GLOBAL de 120/min por fazenda continua, como defesa secundária.
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

  -- Teto GLOBAL da fazenda (defesa secundária).
  SELECT count(*) INTO v_recent
    FROM public.technical_events te
   WHERE te.farm_id = v_farm AND te.created_at > now() - interval '1 minute';
  IF v_recent >= 120 THEN RETURN NULL; END IF;

  -- Teto POR TIPO E ORIGEM (defesa primária).
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
