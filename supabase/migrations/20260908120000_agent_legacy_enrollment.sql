-- ============================================================================
-- MIGRAÇÃO NÃO DESTRUTIVA DE AGENT LEGADO — enrollment de device_license
-- ----------------------------------------------------------------------------
-- O PROBLEMA: `license-provision` só roda quando o agente ainda NÃO tem config
-- (`if (!cfg.email || !cfg.password || !cfg.farmId)`). Um agente legado já
-- operacional nunca entra nesse fluxo, logo nunca recebe `device_licenses`,
-- logo nunca obtém token rotativo por `agent-auth`.
--
-- O QUE ESTA FUNÇÃO NÃO FAZ — e é o ponto principal:
--   • NÃO cria usuário (`auth.admin.createUser`), diferente de license-provision
--   • NÃO toca em `agent_credentials`
--   • NÃO concede role `agent_writer`
--   • NÃO lê nem escreve `farms.license_key`
--   • NÃO toca em config, credentials.enc, email, senha ou farmId do agente
--   Ela cria UMA linha em `device_licenses` e nada mais. A credencial
--   OPERACIONAL existente e a identidade CRIPTOGRÁFICA do dispositivo ficam
--   desacopladas — que era o pedido.
--
-- POR QUE NÃO `license_register_device`: aquela função resolve a fazenda por
-- `farms.license_key`. Usá-la aqui transformaria uma chave estática e
-- compartilhada em credencial bearer de elevação — confiança sem prova da
-- máquina. Aqui a prova é o token one-shot emitido por um admin.
--
-- POR QUE RPC E NÃO UM MODO EM `license-provision`: aquele endpoint é Edge
-- Function (consome Cloud) e seu corpo é quase todo criação de usuário e
-- credenciais. Um modo `existing_agent_migration` seria um desvio que pula 80%
-- da função — mais risco de quebrar o fluxo de instalação nova do que ganho.
-- Como RPC, o caminho legado fica FISICAMENTE separado do de instalação.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.enroll_legacy_agent_device(
  _provisioning_token text,
  _machine_id_hash    text,
  _fingerprint        jsonb DEFAULT '{}'::jsonb,
  _agent_version      text  DEFAULT NULL,
  _ip_address         text  DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tok   RECORD;
  v_dev   RECORD;
  v_id    uuid;
  v_active int;
  v_max    int;
BEGIN
  IF _machine_id_hash IS NULL OR length(btrim(_machine_id_hash)) < 16 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invalid_machine_id');
  END IF;

  -- ── AUTORIZAÇÃO ONE-SHOT ────────────────────────────────────────────────
  -- Reusa `provisioning_tokens`, que já tem tudo: farm_id, expires_at,
  -- consumed_at, consumed_by_machine_hash, created_by, revoked_at.
  -- FOR UPDATE: dois agentes tentando ao mesmo tempo serializam — o segundo
  -- encontra o token já consumido.
  SELECT * INTO v_tok FROM public.provisioning_tokens
   WHERE token = btrim(_provisioning_token)
   FOR UPDATE;

  IF v_tok.id IS NULL      THEN RETURN jsonb_build_object('ok', false, 'error', 'token_not_found'); END IF;
  IF v_tok.revoked_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'token_revoked'); END IF;
  IF v_tok.expires_at <= now()    THEN RETURN jsonb_build_object('ok', false, 'error', 'token_expired'); END IF;

  -- USO ÚNICO — com uma exceção deliberada: se o MESMO hardware repetir a
  -- chamada (retry de rede), devolve a licença existente em vez de erro. É
  -- idempotência, não reutilização: qualquer OUTRA máquina é recusada.
  IF v_tok.consumed_at IS NOT NULL THEN
    IF v_tok.consumed_by_machine_hash IS DISTINCT FROM btrim(_machine_id_hash) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'token_already_used');
    END IF;
    SELECT id INTO v_id FROM public.device_licenses
     WHERE farm_id = v_tok.farm_id AND machine_id_hash = btrim(_machine_id_hash)
       AND revoked_at IS NULL LIMIT 1;
    RETURN jsonb_build_object('ok', true, 'device_id', v_id, 'idempotent', true);
  END IF;

  -- ── A FAZENDA VEM DO TOKEN ──────────────────────────────────────────────
  -- Não há parâmetro de fazenda: provisionar outra farm é impossível.
  -- Se esta máquina já tem licença ATIVA em OUTRA fazenda, recusa — seria
  -- migração de hardware entre clientes, decisão que não cabe a este fluxo.
  SELECT * INTO v_dev FROM public.device_licenses
   WHERE machine_id_hash = btrim(_machine_id_hash) AND revoked_at IS NULL LIMIT 1;
  IF v_dev.id IS NOT NULL AND v_dev.farm_id <> v_tok.farm_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'machine_bound_to_other_farm');
  END IF;

  -- Já existe licença ativa desta máquina NESTA fazenda: nada a fazer.
  IF v_dev.id IS NOT NULL THEN
    UPDATE public.provisioning_tokens
       SET consumed_at = now(), consumed_by_machine_hash = btrim(_machine_id_hash),
           consumed_ip = _ip_address
     WHERE id = v_tok.id;
    RETURN jsonb_build_object('ok', true, 'device_id', v_dev.id, 'already_enrolled', true);
  END IF;

  -- Respeita o teto de dispositivos da fazenda, como o fluxo de instalação.
  SELECT COALESCE(max_devices, device_limit, 1) INTO v_max FROM public.farms WHERE id = v_tok.farm_id;
  SELECT count(*) INTO v_active FROM public.device_licenses
   WHERE farm_id = v_tok.farm_id AND revoked_at IS NULL;
  IF v_max IS NOT NULL AND v_active >= v_max THEN
    RETURN jsonb_build_object('ok', false, 'error', 'device_limit_reached');
  END IF;

  -- ── CRIA SOMENTE A LICENÇA ──────────────────────────────────────────────
  -- current_token_jti/expires_at ficam NULL de propósito: quem os preenche é
  -- `agent-auth`, na primeira autenticação. Nada de token emitido aqui.
  INSERT INTO public.device_licenses (
    farm_id, license_key, machine_id_hash, fingerprint, agent_version,
    activated_at, last_seen_at, ip_address
  ) VALUES (
    v_tok.farm_id, 'ENROLL-' || replace(gen_random_uuid()::text, '-', ''),
    btrim(_machine_id_hash), COALESCE(_fingerprint, '{}'::jsonb), _agent_version,
    now(), now(), _ip_address
  ) RETURNING id INTO v_id;

  UPDATE public.provisioning_tokens
     SET consumed_at = now(), consumed_by_machine_hash = btrim(_machine_id_hash),
         consumed_ip = _ip_address
   WHERE id = v_tok.id;

  RETURN jsonb_build_object('ok', true, 'device_id', v_id, 'farm_id', v_tok.farm_id);
END $$;

COMMENT ON FUNCTION public.enroll_legacy_agent_device IS
  'Migração NÃO destrutiva de Agent legado: cria device_licenses a partir de um provisioning_token one-shot. Não cria usuário, não toca config/credenciais, não usa farms.license_key.';

REVOKE ALL ON FUNCTION public.enroll_legacy_agent_device(text, text, jsonb, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.enroll_legacy_agent_device(text, text, jsonb, text, text)
  TO anon, authenticated, service_role;
-- anon: o agente legado autentica-se pelo TOKEN one-shot, não pelo papel — mesmo
-- modelo de `license-provision`. Sem token válido a função não faz nada.
