-- ============================================================================
-- PROVISIONAMENTO TÉCNICO — FASE 2 (token rotativo) da Fazenda SEMEAR
-- ----------------------------------------------------------------------------
-- Objetivo: garantir o vínculo server-side de que a `agent-auth` precisa para
-- emitir o JWT rotativo, e só então ligar `farms.security_phase = 2`.
--
-- ESCOPO ESTRITO: opera exclusivamente sobre o farm_id abaixo. Não lê, não
-- escreve e não considera nenhuma outra fazenda. Não toca a licença COMERCIAL
-- (chave RNV do painel), `farms.license_key`, relé, automação, pump_runtime,
-- WhatsApp, relatórios oficiais nem `canonical_pipeline_mode`.
--
-- IDEMPOTENTE: rodar N vezes tem o mesmo efeito de rodar uma vez.
-- TRANSACIONAL: tudo dentro de BEGIN/COMMIT — qualquer RAISE aborta sem deixar
-- estado parcial. Rode o bloco inteiro de uma vez no SQL Editor.
--
-- ⚠️ LEIA ANTES DE RODAR — o `machine_id_hash` NÃO pode ser derivado do banco.
--    `agent_hardware.fingerprint` guarda só o MAC primário (`mac_address`) e um
--    `machine_id` de 16 chars truncado sobre `mac|disk|bios|cpu`.
--    A `agent-auth` procura `device_licenses.machine_id_hash`, que o agente
--    calcula como sha256 de `cpu|disk_serial|uuid|<TODOS os MACs ordenados>|hostname`
--    (64 chars). A lista completa de MACs nunca é persistida e o hash é
--    unidirecional → é IMPOSSÍVEL recalcular a partir do `agent_hardware`.
--    Por isso este script tenta descobrir o hash em fontes confiáveis e, se não
--    conseguir, ABORTA pedindo o valor real. Ele nunca inventa um hash.
-- ============================================================================

BEGIN;

DO $provision$
DECLARE
  -- Identificador operacional da Semear (único parâmetro fixo).
  c_farm_id      constant uuid := '0b1d53df-6d5c-4674-8517-9299aac3ec18';

  -- ⇩⇩⇩ PREENCHA SOMENTE SE O SCRIPT ABORTAR PEDINDO O HASH ⇩⇩⇩
  -- 64 caracteres hex, obtidos da própria máquina da Semear (ver mensagem de erro).
  v_machine_hash_manual text := NULL;
  -- ⇧⇧⇧ ------------------------------------------------------ ⇧⇧⇧

  c_tech_key     constant text := 'FASE2-TEC-0b1d53df-6d5c-4674-8517-9299aac3ec18';

  v_farm_name    text;
  v_security     int;
  v_max_devices  int;
  v_hw           record;
  v_fp           jsonb;
  v_hash         text;
  v_cands        text[];
  v_active_cnt   int;
  v_other        record;
  v_tech_id      uuid;
  v_created      boolean := false;
BEGIN
  -- ── 0) GUARDAS DE SCHEMA ──────────────────────────────────────────────────
  -- Falhar aqui é melhor do que gravar num schema diferente do esperado.
  IF to_regclass('public.farms')            IS NULL THEN RAISE EXCEPTION 'SCHEMA: tabela public.farms não existe'; END IF;
  IF to_regclass('public.agent_hardware')   IS NULL THEN RAISE EXCEPTION 'SCHEMA: tabela public.agent_hardware não existe'; END IF;
  IF to_regclass('public.device_licenses')  IS NULL THEN RAISE EXCEPTION 'SCHEMA: tabela public.device_licenses não existe'; END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='farms' AND column_name='security_phase') THEN
    RAISE EXCEPTION 'SCHEMA: farms.security_phase não existe — aplique 20260813100000_agent_security_phase2.sql antes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='device_licenses' AND column_name='machine_id_hash') THEN
    RAISE EXCEPTION 'SCHEMA: device_licenses.machine_id_hash não existe';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='device_licenses' AND column_name='current_token_expires_at') THEN
    RAISE EXCEPTION 'SCHEMA: device_licenses.current_token_expires_at não existe — aplique 20260807200000_agent_auth_token.sql antes';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='agent_hardware' AND column_name='fingerprint') THEN
    RAISE EXCEPTION 'SCHEMA: agent_hardware.fingerprint não existe';
  END IF;

  -- ── 1) FAZENDA (só o farm_id informado) ───────────────────────────────────
  SELECT name, security_phase,
         CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                            WHERE table_schema='public' AND table_name='farms' AND column_name='max_devices')
              THEN max_devices ELSE NULL END
    INTO v_farm_name, v_security, v_max_devices
    FROM public.farms WHERE id = c_farm_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAZENDA: nenhum registro em public.farms com id = %  — confirme o identificador antes de prosseguir', c_farm_id;
  END IF;
  RAISE NOTICE 'Fazenda alvo: % (security_phase atual = %)', v_farm_name, v_security;
  IF v_farm_name IS NULL OR v_farm_name NOT ILIKE '%semear%' THEN
    RAISE NOTICE 'ATENÇÃO: o nome da fazenda ("%") não contém "semear". O farm_id informado é a autoridade, mas CONFIRA antes de commitar.', v_farm_name;
  END IF;

  -- ── 2) HARDWARE DA PRÓPRIA SEMEAR ─────────────────────────────────────────
  -- agent_hardware tem farm_id como PRIMARY KEY → no máximo 1 linha por fazenda.
  SELECT * INTO v_hw FROM public.agent_hardware WHERE farm_id = c_farm_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'HARDWARE: não há linha em public.agent_hardware para a fazenda % — o agente precisa ter rodado ao menos uma vez nessa máquina antes do provisionamento', c_farm_id;
  END IF;
  IF v_hw.fingerprint IS NULL OR v_hw.fingerprint = '{}'::jsonb THEN
    RAISE EXCEPTION 'HARDWARE: agent_hardware.fingerprint está vazio para a fazenda % — nada a vincular', c_farm_id;
  END IF;
  IF v_hw.alert_level = 'blocked' THEN
    RAISE EXCEPTION 'HARDWARE: agent_hardware.alert_level = blocked (componentes alterados: %) — resolva o alerta antes de emitir licença técnica', v_hw.changed_components;
  END IF;
  IF v_hw.alert_level = 'warning' THEN
    RAISE NOTICE 'ATENÇÃO: agent_hardware.alert_level = warning (mudou: %) — vinculando mesmo assim, confira se a troca de peça foi legítima.', v_hw.changed_components;
  END IF;

  -- Remapeia para as chaves que a agent-auth/ingest realmente comparam.
  -- agent_hardware usa cpu_id/bios_uuid; o agente envia cpu/uuid/disk_serial.
  -- Só as três "fortes" entram: são as únicas que contam divergência.
  v_fp := jsonb_strip_nulls(jsonb_build_object(
            'cpu',         NULLIF(v_hw.fingerprint->>'cpu_id', ''),
            'disk_serial', NULLIF(v_hw.fingerprint->>'disk_serial', ''),
            'uuid',        NULLIF(v_hw.fingerprint->>'bios_uuid', ''),
            'hostname',    NULLIF(v_hw.fingerprint->>'hostname', '')));
  IF v_fp = '{}'::jsonb THEN
    RAISE EXCEPTION 'HARDWARE: fingerprint da fazenda % não tem nenhum componente forte (cpu/disk_serial/uuid) — vínculo seria inútil', c_farm_id;
  END IF;

  -- ── 3) machine_id_hash — descoberta ou parâmetro, NUNCA inventado ─────────
  IF v_machine_hash_manual IS NOT NULL THEN
    v_hash := lower(trim(v_machine_hash_manual));
    IF v_hash !~ '^[0-9a-f]{64}$' THEN
      RAISE EXCEPTION 'PARÂMETRO: v_machine_hash_manual não é um sha256 hex de 64 caracteres (recebido: % chars)', length(v_hash);
    END IF;
    RAISE NOTICE 'machine_id_hash: fornecido manualmente.';
  ELSE
    -- ÚNICA fonte automática confiável: licença ATIVA já existente desta fazenda
    -- (caminho normal — o agente se registrou via license-provision e o vínculo
    -- já está correto). NÃO usamos agent_security_events como fonte: o hash lá
    -- vem de quem FALHOU a validação, o que inclui justamente uma máquina
    -- clonada. Provisionar a partir dele seria emitir licença para o atacante.
    SELECT array_agg(DISTINCT machine_id_hash) INTO v_cands
      FROM public.device_licenses
     WHERE farm_id = c_farm_id AND revoked_at IS NULL
       AND machine_id_hash ~ '^[0-9a-f]{64}$';

    IF v_cands IS NULL OR array_length(v_cands, 1) IS NULL THEN
      RAISE EXCEPTION USING MESSAGE =
        'machine_id_hash NÃO DESCOBERTO para a fazenda ' || c_farm_id || '. '
        || 'Ele NÃO é derivável de agent_hardware (só o MAC primário é guardado, e o machine_id de lá tem 16 chars truncados sobre outra combinação). '
        || 'Obtenha o valor REAL na máquina da Semear e preencha v_machine_hash_manual no topo deste arquivo. '
        || 'Fonte: o agente calcula sha256("cpu|disk_serial|uuid|<MACs não-internos ordenados>|hostname") — ver getMachineFingerprint() '
        || 'em electron-agent/main.cjs; o mesmo valor fica gravado no config do agente como machineIdHash. '
        || 'Pistas (NÃO confiáveis — podem ser de máquina clonada, apenas confira contra a máquina real): '
        || COALESCE((SELECT string_agg(DISTINCT left(ase.details->>'machine_id_hash', 8) || '…', ', ')
                       FROM public.agent_security_events ase
                      WHERE ase.farm_id = c_farm_id
                        AND jsonb_exists(ase.details, 'machine_id_hash')
                        AND ase.details->>'machine_id_hash' ~ '^[0-9a-f]{64}$'), 'nenhuma');
    END IF;

    IF array_length(v_cands, 1) > 1 THEN
      RAISE EXCEPTION 'AMBIGUIDADE: % licenças ativas com machine_id_hash distintos na fazenda % (%). Resolva manualmente qual é a máquina atual e use v_machine_hash_manual.',
        array_length(v_cands, 1), c_farm_id,
        (SELECT string_agg(left(x, 8) || '…', ', ') FROM unnest(v_cands) x);
    END IF;

    v_hash := v_cands[1];
    RAISE NOTICE 'machine_id_hash: obtido da licença ativa da própria fazenda (%…).', left(v_hash, 8);
  END IF;

  -- ── 3.1) COERÊNCIA hardware × licença (mesma regra da agent-auth) ─────────
  -- Se a licença ativa aponta para um hardware que diverge do que o agente
  -- registrou em agent_hardware em >= 2 componentes fortes, a agent-auth
  -- responderia 403/fingerprint_mismatch. Melhor abortar aqui do que ligar a
  -- FASE 2 num vínculo que já nasce quebrado.
  SELECT id, license_key, fingerprint INTO v_other
    FROM public.device_licenses
   WHERE farm_id = c_farm_id AND revoked_at IS NULL AND machine_id_hash = v_hash
   LIMIT 1;
  IF FOUND AND v_other.fingerprint IS NOT NULL THEN
    IF ( (COALESCE(NULLIF(v_other.fingerprint->>'cpu',''), '') <> ''
          AND COALESCE(v_fp->>'cpu','') <> ''
          AND v_other.fingerprint->>'cpu' IS DISTINCT FROM v_fp->>'cpu')::int
       + (COALESCE(NULLIF(v_other.fingerprint->>'disk_serial',''), '') <> ''
          AND COALESCE(v_fp->>'disk_serial','') <> ''
          AND v_other.fingerprint->>'disk_serial' IS DISTINCT FROM v_fp->>'disk_serial')::int
       + (COALESCE(NULLIF(v_other.fingerprint->>'uuid',''), '') <> ''
          AND COALESCE(v_fp->>'uuid','') <> ''
          AND v_other.fingerprint->>'uuid' IS DISTINCT FROM v_fp->>'uuid')::int
       ) >= 2 THEN
      RAISE EXCEPTION 'INCOERÊNCIA: a licença ativa (key %…) aponta para hardware que diverge em >= 2 componentes fortes do registrado em agent_hardware da fazenda %. A agent-auth recusaria com fingerprint_mismatch. Verifique se a máquina foi trocada antes de provisionar.',
        left(v_other.license_key, 6), c_farm_id;
    END IF;
  END IF;

  -- ── 4) LICENÇA TÉCNICA — nunca mexe na comercial ──────────────────────────
  -- 4.1 Já existe licença ATIVA desta fazenda com OUTRO hardware? Aborta: ou é a
  --     comercial de outra máquina, ou o hardware trocou. Não é decisão do script.
  SELECT id, license_key, machine_id_hash INTO v_other
    FROM public.device_licenses
   WHERE farm_id = c_farm_id AND revoked_at IS NULL
     AND machine_id_hash IS DISTINCT FROM v_hash
     AND license_key IS DISTINCT FROM c_tech_key
   LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'CONFLITO: já existe licença ativa da fazenda % (key %…, hw %…) apontando para hardware DIFERENTE do alvo (%…). Revise manualmente — este script não altera licença comercial.',
      c_farm_id, left(v_other.license_key, 6), left(v_other.machine_id_hash, 8), left(v_hash, 8);
  END IF;

  -- 4.2 Já existe licença ATIVA (qualquer, inclusive comercial) com o hardware
  --     CORRETO? Então o vínculo da FASE 2 já está satisfeito — não duplica.
  SELECT id, license_key INTO v_other
    FROM public.device_licenses
   WHERE farm_id = c_farm_id AND revoked_at IS NULL
     AND machine_id_hash = v_hash
     AND license_key IS DISTINCT FROM c_tech_key
   LIMIT 1;
  IF FOUND THEN
    RAISE NOTICE 'Licença ativa já vinculada ao hardware correto (key %…) — nenhuma licença técnica será criada.', left(v_other.license_key, 6);
  ELSE
    -- 4.3 Cria/atualiza APENAS a licença técnica, identificada por license_key própria.
    SELECT id INTO v_tech_id FROM public.device_licenses WHERE license_key = c_tech_key;

    IF v_tech_id IS NULL THEN
      -- respeita o limite de dispositivos da fazenda (license_register_device conta
      -- TODAS as licenças ativas — criar a técnica consome um slot).
      IF v_max_devices IS NOT NULL AND v_max_devices > 0 THEN
        SELECT count(*) INTO v_active_cnt FROM public.device_licenses
         WHERE farm_id = c_farm_id AND revoked_at IS NULL;
        IF v_active_cnt >= v_max_devices THEN
          RAISE EXCEPTION 'LIMITE: fazenda % já tem % licença(s) ativa(s) e max_devices = %. Criar a técnica bloquearia registros comerciais futuros — ajuste max_devices ou revogue o que estiver obsoleto.',
            c_farm_id, v_active_cnt, v_max_devices;
        END IF;
      END IF;

      INSERT INTO public.device_licenses
        (farm_id, license_key, machine_id_hash, fingerprint, agent_version, activated_at, last_seen_at)
      VALUES
        (c_farm_id, c_tech_key, v_hash, v_fp, v_hw.agent_version, now(), now())
      RETURNING id INTO v_tech_id;
      v_created := true;
      RAISE NOTICE 'Licença TÉCNICA criada (id %).', v_tech_id;
    ELSE
      UPDATE public.device_licenses
         SET farm_id         = c_farm_id,
             machine_id_hash = v_hash,
             fingerprint     = v_fp,
             agent_version   = COALESCE(v_hw.agent_version, agent_version),
             revoked_at      = NULL,
             revoked_reason  = NULL,
             updated_at      = now()
       WHERE id = v_tech_id;
      RAISE NOTICE 'Licença TÉCNICA já existia (id %) — atualizada/reativada.', v_tech_id;
    END IF;
  END IF;

  -- ── 5) FASE 2 — só depois do vínculo, e só nesta fazenda ──────────────────
  UPDATE public.farms SET security_phase = 2
   WHERE id = c_farm_id AND security_phase < 2;
  IF FOUND THEN
    RAISE NOTICE 'security_phase elevado para 2 na fazenda %.', c_farm_id;
  ELSE
    RAISE NOTICE 'security_phase já era >= 2 — nada alterado.';
  END IF;

  PERFORM v_created; -- silencia aviso de variável não lida em alguns linters
END
$provision$;

-- ── CONFERÊNCIA (mascarada — nunca expõe hash/fingerprint completos) ────────
SELECT
  f.id                                             AS farm_id,
  f.name                                           AS fazenda,
  f.security_phase,
  (dl.id IS NOT NULL)                              AS licenca_tecnica_ativa,
  CASE WHEN dl.machine_id_hash IS NULL THEN NULL
       ELSE left(dl.machine_id_hash, 8) || '…' || right(dl.machine_id_hash, 4)
  END                                              AS machine_id_mascarado,
  CASE WHEN dl.fingerprint->>'cpu' IS NULL THEN NULL
       ELSE left(dl.fingerprint->>'cpu', 4) || '…' END        AS fp_cpu_mascarado,
  CASE WHEN dl.fingerprint->>'uuid' IS NULL THEN NULL
       ELSE left(dl.fingerprint->>'uuid', 8) || '…' END       AS fp_uuid_mascarado,
  dl.activated_at,
  dl.last_seen_at,
  dl.current_token_expires_at,
  (SELECT count(*) FROM public.device_licenses d
    WHERE d.farm_id = f.id AND d.revoked_at IS NULL)          AS licencas_ativas_total
FROM public.farms f
LEFT JOIN public.device_licenses dl
       ON dl.farm_id = f.id
      AND dl.license_key = 'FASE2-TEC-0b1d53df-6d5c-4674-8517-9299aac3ec18'
      AND dl.revoked_at IS NULL
WHERE f.id = '0b1d53df-6d5c-4674-8517-9299aac3ec18';

COMMIT;

-- ============================================================================
-- ROLLBACK — restrito à Semear. Descomente e rode SÓ se precisar desfazer.
-- Revoga apenas a licença TÉCNICA criada aqui (identificada pela license_key
-- própria) e devolve security_phase para 0. Não encosta na licença comercial.
-- ============================================================================
-- BEGIN;
--   UPDATE public.device_licenses
--      SET revoked_at = now(),
--          revoked_reason = 'rollback provisionamento FASE 2 (técnico)',
--          current_token_jti = NULL,
--          current_token_expires_at = NULL,
--          updated_at = now()
--    WHERE farm_id = '0b1d53df-6d5c-4674-8517-9299aac3ec18'
--      AND license_key = 'FASE2-TEC-0b1d53df-6d5c-4674-8517-9299aac3ec18'
--      AND revoked_at IS NULL;
--
--   UPDATE public.farms
--      SET security_phase = 0
--    WHERE id = '0b1d53df-6d5c-4674-8517-9299aac3ec18';
--
--   SELECT id, name, security_phase FROM public.farms
--    WHERE id = '0b1d53df-6d5c-4674-8517-9299aac3ec18';
-- COMMIT;
