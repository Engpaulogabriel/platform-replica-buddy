-- ============================================================================
-- AUTORIA DE MECANISMO REMOTO SEM USUÁRIO HUMANO
-- ----------------------------------------------------------------------------
-- `classify_physical_transition` só atribuía autoria remota quando o comando
-- tinha `created_by` preenchido (ou era WhatsApp). O Modo Automático cria
-- comandos com created_by NULL e source_device='cloud-automation' — logo, três
-- transições físicas REAIS da Sossego em 22/09, causadas por ele e confirmadas
-- pela telemetria, foram gravadas como origin='system'/'unidentified'. Com a
-- regra de exibição de duas categorias, isso vira "Local · Acionamento local":
-- o relatório afirmaria acionamento no painel onde quem ligou foi a automação.
--
-- Mecanismo legítimo pode agir sem pessoa. A pergunta certa não é "há usuário?"
-- e sim "há mecanismo remoto responsável comprovado?".
--
-- NÃO altera atuação, frame, TX, polling, desired_running, last_outputs_state,
-- schedules, Agent nem o backend antigo.
-- ============================================================================

-- ── 1) CLASSIFICADOR ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.classify_physical_transition(_equipment_id uuid, _farm_id uuid, _turning_on boolean, _at timestamp with time zone DEFAULT now(), _window interval DEFAULT '00:03:00'::interval)
 RETURNS TABLE(origin event_origin, actor_label text, user_id uuid, user_email text, command_id uuid, authorship_source text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_intent text; r record; v_rule text;
  v_saida int; v_wa text; v_act_origin text;
BEGIN
  v_intent := CASE WHEN _turning_on THEN 'turn_on' ELSE 'turn_off' END;
  SELECT COALESCE(saida,1), last_actuation_origin INTO v_saida, v_act_origin
    FROM public.equipments WHERE id = _equipment_id;

  -- ── (2) AUTOMAÇÃO COMPATÍVEL ────────────────────────────────────────────
  IF NOT _turning_on AND EXISTS (
       SELECT 1 FROM public.commands c
        WHERE c.equipment_id = _equipment_id
          AND c.source_device LIKE 'backend-reset:scheduled_shutdown%'
          AND c.created_at BETWEEN _at - interval '10 minutes' AND _at + interval '2 minutes')
  THEN
    SELECT NULLIF(btrim(e.last_changed_by),'') INTO v_rule
      FROM public.equipments e WHERE e.id = _equipment_id;
    RETURN QUERY SELECT 'auto'::public.event_origin,
      COALESCE(v_rule,'Desligamento Programado'), NULL::uuid, NULL::text,
      NULL::uuid, 'scheduled_command';
    RETURN;
  END IF;

  IF NOT _turning_on THEN
    SELECT sa.name INTO v_rule
      FROM public.scheduled_automations sa
     WHERE sa.farm_id = _farm_id AND sa.is_active
       AND sa.time_brt ~ '^[0-9]{1,2}:[0-9]{2}'
       AND (sa.days_of_week IS NULL OR array_length(sa.days_of_week,1) IS NULL
            OR (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[
                 extract(dow from (_at AT TIME ZONE 'America/Bahia'))::int + 1] = ANY(sa.days_of_week))
       AND (extract(hour from (_at AT TIME ZONE 'America/Bahia'))::int * 60
            + extract(minute from (_at AT TIME ZONE 'America/Bahia'))::int)
           BETWEEN ((substring(sa.time_brt from '^([0-9]{1,2})')::int)*60
                    + (substring(sa.time_brt from ':([0-9]{2})')::int)) - 5
               AND ((substring(sa.time_brt from '^([0-9]{1,2})')::int)*60
                    + (substring(sa.time_brt from ':([0-9]{2})')::int))
                   + (COALESCE(sa.max_retries,3) * COALESCE(sa.retry_interval_min,5)) + 5
     ORDER BY sa.time_brt LIMIT 1;
    IF v_rule IS NOT NULL THEN
      RETURN QUERY SELECT 'auto'::public.event_origin, v_rule,
        NULL::uuid, NULL::text, NULL::uuid, 'scheduled_window';
      RETURN;
    END IF;
  END IF;

  -- ── (3) COMANDO CORRELACIONADO — a evidência vem do próprio comando ─────
  -- commands é a fonte viva; command_audit é a cópia durável (o comando é
  -- apagado quando termina). A intenção sai do frame, não de rótulo gravado.
  WITH cand AS (
    SELECT c.id AS cid, c.created_at AS at, c.source_device AS src,
           c.created_by AS uid, c.frame AS frame
      FROM public.commands c
     WHERE c.equipment_id = _equipment_id
       AND c.type = 'manual'::public.command_type
       AND COALESCE(c.source_device,'') NOT LIKE 'backend-reset:%'
       -- comando que terminou SEM confirmar não explica transição nenhuma:
       -- depois do timeout, uma mudança física é espontânea até prova em
       -- contrário, e o relatório deve dizer Local.
       AND c.status NOT IN ('timeout'::public.command_status,
                            'error'::public.command_status,
                            'cancelled'::public.command_status)
       AND c.created_at BETWEEN _at - _window AND _at + _window
    UNION ALL
    SELECT ca.command_id, ca.command_created_at, ca.source_device,
           ca.user_id, ca.frame
      FROM public.command_audit ca
     WHERE ca.equipment_id = _equipment_id
       AND COALESCE(ca.source_device,'') NOT LIKE 'backend-reset:%'
       AND COALESCE(ca.status_final,'') NOT IN ('timeout','error','cancelled')
       AND ca.command_created_at BETWEEN _at - _window AND _at + _window
  )
  SELECT cand.cid, cand.src, cand.uid, p.full_name, p.email
    INTO r
    FROM cand LEFT JOIN public.profiles p ON p.id = cand.uid
   WHERE COALESCE(public.command_intent_from_frame(cand.frame, v_saida), v_intent) = v_intent
   ORDER BY (public.command_intent_from_frame(cand.frame, v_saida) IS NULL),
            abs(extract(epoch FROM (cand.at - _at)))
   LIMIT 1;

  IF FOUND THEN
    -- WhatsApp: o operador real está em source_device, não em created_by.
    IF lower(COALESCE(r.src,'')) LIKE 'whatsapp:%' THEN
      v_wa := btrim(split_part(substr(r.src, strpos(r.src, ':') + 1), '|', 1));
      -- só dígitos/pontuação = telefone; telefone não é nome e não vai à tela
      IF v_wa ~ '^[+0-9 ()\-]*$' THEN v_wa := NULL; END IF;
      RETURN QUERY SELECT 'whatsapp'::public.event_origin,
        COALESCE(NULLIF(v_wa,''), r.full_name, r.email),
        r.uid, r.email, r.cid, 'whatsapp_source_device';
      RETURN;
    END IF;
    IF r.uid IS NOT NULL THEN
      RETURN QUERY SELECT 'remote'::public.event_origin,
        COALESCE(r.full_name, r.email), r.uid, r.email, r.cid, 'command_created_by';
      RETURN;
    END IF;

    -- MECANISMO REMOTO SEM USUÁRIO HUMANO.
    -- `created_by IS NOT NULL` não pode ser requisito universal de autoria: o
    -- Modo Automático e a proteção da nuvem agem legitimamente sem pessoa. A
    -- pergunta certa é se EXISTE mecanismo remoto responsável comprovado.
    -- Em 22/09 três transições reais da Sossego, causadas pelo Modo Automático
    -- (comandos 87043f1a, 015465c3, c9d9f583), caíram aqui sem atribuição e o
    -- relatório as mostraria como "Local · Acionamento local".
    --
    -- A lista é fechada de propósito. NÃO entram:
    --  · backend-reset:local_shutdown_detected — é CONSEQUÊNCIA de um
    --    desligamento local detectado; chamá-lo de remoto inverteria causa e
    --    efeito (6 linhas no histórico, todas corretamente locais hoje);
    --  · backend-reset:turn_on_timeout e :manual_reset — TX de segurança e
    --    recuperação técnica, não acionamento operacional;
    --  · startup-sync — reconciliação de estado na subida do agente, evidência
    --    insuficiente para afirmar causa.
    -- Comando que terminou em timeout/error/cancelled já foi excluído do
    -- candidato acima, então mecanismo que não confirmou não atribui nada.
    IF lower(COALESCE(r.src,'')) = 'cloud-automation' THEN
      RETURN QUERY SELECT 'auto'::public.event_origin,
        public.automatic_mode_actor_label(r.cid),
        NULL::uuid, NULL::text, r.cid, 'cloud_automation';
      RETURN;
    END IF;
    IF lower(COALESCE(r.src,'')) = 'cloud-protective-off' THEN
      RETURN QUERY SELECT 'auto'::public.event_origin, 'Proteção automática',
        NULL::uuid, NULL::text, r.cid, 'cloud_protective_off';
      RETURN;
    END IF;
  END IF;

  -- ── (4) SEM CORRELAÇÃO ──────────────────────────────────────────────────
  -- Local só com evidência: a telemetria precisa ter declarado atuação local.
  IF lower(COALESCE(v_act_origin,'')) = 'local' THEN
    RETURN QUERY SELECT 'local'::public.event_origin, 'Acionamento local',
      NULL::uuid, NULL::text, NULL::uuid, 'local_declared';
    RETURN;
  END IF;

  -- Transição observada sem origem comprovada. Entra no histórico como tal.
  RETURN QUERY SELECT 'system'::public.event_origin, NULL::text,
    NULL::uuid, NULL::text, NULL::uuid, 'unidentified';
END; $function$;

-- ── 2) CORREÇÃO HISTÓRICA — só o que está individualmente provado ──────────
-- Cada linha abaixo tem transição física confirmada E comando correlacionado
-- por intenção (bit da saída no frame), dentro de 3 minutos, com status que
-- não é timeout/error/cancelled. Nada foi inferido por proximidade.
--
-- FORA da correção, de propósito:
--   6 linhas backend-reset:local_shutdown_detected → já corretamente 'local'
--   2 linhas cloud-protective-off cujo comando deu TIMEOUT → ambíguo
--   3 linhas startup-sync → evidência insuficiente
BEGIN;

-- Modo Automático (Fazenda Sossego, 22/09)
UPDATE public.automation_log al
   SET origin = 'auto'::public.event_origin,
       actor_label = public.automatic_mode_actor_label((al.details->>'command_id')::uuid),
       details = coalesce(al.details,'{}'::jsonb) || jsonb_build_object(
                   'authorship_backfill', jsonb_build_object(
                     'at', now(), 'reason', 'cloud_automation_nao_atribuida',
                     'evidence', 'commands.source_device=cloud-automation + intent do frame',
                     'previous_origin', al.origin::text,
                     'previous_actor_label', al.actor_label))
 WHERE al.id = ANY(ARRAY[
         'd7542df3-35e3-4c88-b53a-773477c60900',
         '4eb3e5fd-1f00-4d74-8327-26b57d6c707a',
         'e563e7a8-3939-4f45-bc48-05b621f6dd76']::uuid[])
   AND al.origin = 'system'::public.event_origin;

-- Os três tinham a chave 'command_id' presente com valor NULO (o escritor
-- canônico sempre grava a chave), então o rótulo caía no genérico
-- 'Modo Automático'. Com o vínculo correto, automatic_mode_actor_label devolve
-- o horário real da regra: "Automático 21:02/21:03/21:04". Idempotente: só
-- grava onde ainda está nulo.
UPDATE public.automation_log al
   SET details = al.details || jsonb_build_object('command_id', v.cmd),
       actor_label = public.automatic_mode_actor_label(v.cmd::uuid)
  FROM (VALUES
     ('d7542df3-35e3-4c88-b53a-773477c60900','87043f1a-aa35-4152-a622-ac72d5197e99'),
     ('4eb3e5fd-1f00-4d74-8327-26b57d6c707a','015465c3-a0d1-4553-b72d-1b160c4a058b'),
     ('e563e7a8-3939-4f45-bc48-05b621f6dd76','c9d9f583-6f91-4e6d-ace1-b19c16d6b42e')
   ) AS v(id, cmd)
 WHERE al.id = v.id::uuid
   AND al.details->>'command_id' IS DISTINCT FROM v.cmd;

-- Proteção automática (Pérola, POÇO 20) — comando executado, transição em ≤8s
UPDATE public.automation_log al
   SET origin = 'auto'::public.event_origin,
       actor_label = 'Proteção automática',
       details = coalesce(al.details,'{}'::jsonb) || jsonb_build_object(
                   'authorship_backfill', jsonb_build_object(
                     'at', now(), 'reason', 'cloud_protective_off_nao_atribuida',
                     'evidence', 'command_audit.source_device=cloud-protective-off, status executed',
                     'previous_origin', al.origin::text,
                     'previous_actor_label', al.actor_label))
 WHERE al.id = ANY(ARRAY[
         '267e7a26-4329-4ba3-a3e1-97e6ab674595',
         '092a3df6-b753-4526-ad21-2bc49027d278']::uuid[])
   AND al.origin = 'local'::public.event_origin;

DO $$
DECLARE v_pend int; v_par int;
BEGIN
  SELECT count(*) INTO v_pend FROM public.automation_log
   WHERE id = ANY(ARRAY['d7542df3-35e3-4c88-b53a-773477c60900',
                        '4eb3e5fd-1f00-4d74-8327-26b57d6c707a',
                        'e563e7a8-3939-4f45-bc48-05b621f6dd76',
                        '267e7a26-4329-4ba3-a3e1-97e6ab674595',
                        '092a3df6-b753-4526-ad21-2bc49027d278']::uuid[])
     AND origin <> 'auto'::public.event_origin;
  IF v_pend <> 0 THEN RAISE EXCEPTION 'abortado: % linhas nao reclassificadas', v_pend; END IF;

  -- nenhuma linha remota pode ficar com nome de acionamento local
  SELECT count(*) INTO v_par FROM public.automation_log
   WHERE noise_reason IS NULL
     AND action IN ('turn_on','turn_off','pump_on','pump_off')
     AND origin <> 'local'::public.event_origin
     AND lower(coalesce(actor_label,'')) = 'acionamento local';
  IF v_par <> 0 THEN RAISE EXCEPTION 'abortado: % pares Remoto+Acionamento local', v_par; END IF;

  RAISE NOTICE 'autoria de mecanismo remoto OK';
END $$;

COMMIT;
