-- ============================================================================
-- RELATÓRIO DE AUTOMAÇÃO — P0 de AUTORIA e SEMÂNTICA. Só classificação.
-- ----------------------------------------------------------------------------
-- O relatório da Semear atribuiu a "Admin Renov" acionamentos feitos pelo Yuri,
-- e o da Sossego chamou de "Acionamento local" transições que ninguém provou
-- serem locais. Três defeitos, todos de CLASSIFICAÇÃO:
--
--  1. a intenção do comando era derivada por `frame ~ '\{0*1\}'`, regex que
--     nunca casa payload de 6 saídas ("{100000}") — todo LIGAR virava
--     'turn_off' no command_audit, o ramo do WhatsApp nunca casava e a linha
--     caía no ramo genérico, que crava origin='remote' e usa o perfil de
--     `created_by`;
--  2. a autoria do WhatsApp era buscada em `created_by`, que podia ter sido
--     preenchido com o admin da fazenda, em vez de `source_device`, que
--     preserva o operador real ('whatsapp:Yuri|<fone>');
--  3. "nenhuma correlação encontrada" era gravado como origin='local' +
--     'Acionamento local' — afirmação sobre o mundo físico que o sistema não
--     tem como sustentar.
--
-- NÃO cria comando. NÃO altera desired_running, last_outputs_state, frame,
-- polling, automação, RLS, grants, agente, serial ou PLC. NÃO reescreve
-- histórico. Só muda como um evento NOVO é rotulado.
-- ============================================================================

-- ── 1) INTENÇÃO DO COMANDO, DETERMINÍSTICA ─────────────────────────────────
-- Lê o bit da saída do equipamento dentro do payload do frame. Sem heurística
-- por comprimento. Quando não dá para decidir, devolve NULL — não inventa.
CREATE OR REPLACE FUNCTION public.command_intent_from_frame(_frame text, _saida int)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE v_payload text; v_bit text; v_idx int;
BEGIN
  v_payload := substring(COALESCE(_frame,'') from '\{([01]+)\}');
  IF v_payload IS NULL THEN RETURN NULL; END IF;

  IF length(v_payload) = 1 THEN
    v_bit := v_payload;                       -- PLC de uma saída
  ELSE
    v_idx := COALESCE(_saida, 0);
    IF v_idx < 1 OR v_idx > length(v_payload) THEN RETURN NULL; END IF;
    v_bit := substring(v_payload from v_idx for 1);
  END IF;

  RETURN CASE v_bit WHEN '1' THEN 'turn_on' WHEN '0' THEN 'turn_off' ELSE NULL END;
END; $$;
GRANT EXECUTE ON FUNCTION public.command_intent_from_frame(text,int) TO authenticated, service_role;

-- ── 2) command_audit passa a gravar a intenção correta ─────────────────────
CREATE OR REPLACE FUNCTION public.capture_command_audit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c public.commands%ROWTYPE;
  v_email text; v_name text; v_equip text; v_saida int;
BEGIN
  c := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF c.id IS NULL OR c.farm_id IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;

  SELECT email, full_name INTO v_email, v_name FROM public.profiles WHERE id = c.created_by;
  SELECT name, COALESCE(saida,1) INTO v_equip, v_saida
    FROM public.equipments WHERE id = c.equipment_id;

  INSERT INTO public.command_audit (
    command_id, client_event_id, farm_id, equipment_id, equipment_name,
    user_id, user_email, actor_label, origin_kind,
    intent, frame, source_device, status_final,
    command_created_at, sent_at, responded_at, details)
  VALUES (
    c.id, c.client_event_id, c.farm_id, c.equipment_id, v_equip,
    c.created_by, v_email,
    NULLIF(btrim(COALESCE(v_name, v_email, '')), ''),
    public.classify_command_origin_kind(c.source_device, c.created_by),
    public.command_intent_from_frame(c.frame, v_saida),   -- era regex '\{0*1\}'
    c.frame, c.source_device, c.status::text,
    c.created_at, c.sent_at, c.responded_at,
    jsonb_build_object('captured_on', TG_OP, 'command_type', c.type::text))
  ON CONFLICT (command_id) DO UPDATE SET
    user_id       = COALESCE(public.command_audit.user_id, EXCLUDED.user_id),
    user_email    = COALESCE(public.command_audit.user_email, EXCLUDED.user_email),
    -- só ENRIQUECE; autoria já registrada nunca é apagada por reprocesso
    actor_label   = COALESCE(public.command_audit.actor_label, EXCLUDED.actor_label),
    intent        = COALESCE(EXCLUDED.intent, public.command_audit.intent),
    status_final  = COALESCE(EXCLUDED.status_final, public.command_audit.status_final),
    responded_at  = COALESCE(EXCLUDED.responded_at, public.command_audit.responded_at),
    sent_at       = COALESCE(EXCLUDED.sent_at, public.command_audit.sent_at);

  RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END;
END; $$;

-- ── 3) O WhatsApp tem posto no ranking de atribuição ───────────────────────
CREATE OR REPLACE FUNCTION public.automation_attribution_rank(
  _origin public.event_origin, _user_id uuid, _source_device text, _actor text)
RETURNS int LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN _origin = 'whatsapp'::public.event_origin THEN 4
    WHEN _origin = 'remote'::public.event_origin
         AND (_user_id IS NOT NULL OR lower(COALESCE(_source_device,'')) LIKE 'whatsapp:%') THEN 4
    WHEN _origin = 'auto'::public.event_origin AND COALESCE(_actor,'') <> '' THEN 3
    WHEN _origin = 'auto'::public.event_origin THEN 3
    WHEN _origin = 'local'::public.event_origin THEN 2
    ELSE 1
  END;
$$;

-- ── 4) Classificação da transição física ───────────────────────────────────
-- Mudanças: (a) o comando correlacionado é procurado em commands E em
-- command_audit (commands some quando o comando termina), com a intenção lida
-- do frame; (b) `source_device` 'whatsapp:Nome|fone' é a prova de autoria do
-- WhatsApp, acima de created_by; (c) sem correlação, o evento NÃO é declarado
-- local — vira 'system', que o relatório mostra como "Origem não identificada".
-- Local só quando a telemetria declarou local (last_actuation_origin='local').
CREATE OR REPLACE FUNCTION public.classify_physical_transition(
  _equipment_id uuid, _farm_id uuid, _turning_on boolean,
  _at timestamptz DEFAULT now(), _window interval DEFAULT interval '3 minutes')
RETURNS TABLE (origin public.event_origin, actor_label text, user_id uuid,
               user_email text, command_id uuid, authorship_source text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
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
       AND c.created_at BETWEEN _at - _window AND _at + _window
    UNION ALL
    SELECT ca.command_id, ca.command_created_at, ca.source_device,
           ca.user_id, ca.frame
      FROM public.command_audit ca
     WHERE ca.equipment_id = _equipment_id
       AND COALESCE(ca.source_device,'') NOT LIKE 'backend-reset:%'
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
END; $$;
GRANT EXECUTE ON FUNCTION public.classify_physical_transition(uuid,uuid,boolean,timestamptz,interval)
  TO authenticated, service_role;

-- ── 5) A guarda para de converter origem desconhecida em "Local" ───────────
CREATE OR REPLACE FUNCTION public.guard_official_report_row()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.noise_reason IS NOT NULL THEN RETURN NEW; END IF;

  IF NEW.action NOT IN ('turn_on','turn_off','pump_on','pump_off') THEN
    NEW.noise_reason := 'technical_not_a_transition'; RETURN NEW;
  END IF;
  IF NEW.origin = 'reading'::public.event_origin THEN
    NEW.noise_reason := 'technical_not_a_transition'; RETURN NEW;
  END IF;
  IF NEW.equipment_id IS NULL THEN
    NEW.noise_reason := 'no_equipment'; RETURN NEW;
  END IF;

  IF NEW.result IS DISTINCT FROM 'success'::public.event_result
     AND COALESCE(NEW.details->>'state_confirmed','') <> 'true' THEN
    NEW.noise_reason := 'command_not_confirmed'; RETURN NEW;
  END IF;

  -- ANTES: origin='system' virava 'local' + 'Acionamento local'. Isso afirmava
  -- acionamento humano no painel sem nenhuma prova. Agora a linha permanece
  -- 'system' — transição real, origem não identificada — e segue sem autor.
  IF NEW.origin = 'system'::public.event_origin THEN
    NEW.details := COALESCE(NEW.details,'{}'::jsonb)
                   || jsonb_build_object('unidentified_origin', true);
    RETURN NEW;
  END IF;

  IF public.is_technical_actor_label(NEW.actor_label) THEN
    IF NEW.origin = 'local'::public.event_origin THEN
      NEW.actor_label := 'Acionamento local';
    ELSE
      NEW.actor_label := NULL;
    END IF;
    NEW.details := COALESCE(NEW.details,'{}'::jsonb)
                   || jsonb_build_object('technical_label_stripped', true);
  END IF;

  IF NEW.origin = 'local'::public.event_origin
     AND COALESCE(btrim(NEW.actor_label),'') = '' THEN
    NEW.actor_label := 'Acionamento local';
  END IF;

  RETURN NEW;
END; $$;

-- ============================================================================
-- ROLLBACK: reaplicar 20260820120000_canonical_physical_writer.sql (writer e
-- guarda) e 20260814143900 (capture_command_audit). Nenhuma linha histórica é
-- tocada por esta migration.
-- ============================================================================
