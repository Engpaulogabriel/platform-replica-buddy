-- ============================================================================
-- AUTORIA DE COMANDOS — global, para TODAS as fazendas e TODO o histórico.
-- ----------------------------------------------------------------------------
-- Objetivo: zero comando remoto FUTURO sem autoria, e correção do PASSADO
-- sempre que houver prova suficiente. Nenhum nome de pessoa ou de fazenda
-- aparece neste arquivo — a evidência é sempre um UUID.
--
-- Problema estrutural: a autoria vive em `commands.created_by`, e `commands` é
-- uma tabela de trabalho (existe delete_finished_command; hoje o gatilho está
-- desativado, mas a função permanece e pode voltar por cron). Autoria não pode
-- depender de tabela que será apagada.
--
-- 1) command_audit: append-only, capturada na conclusão E antes de qualquer
--    DELETE. É a fonte durável de "quem mandou".
-- 2) Backfill global com HIERARQUIA DE EVIDÊNCIA (nunca por nome isolado).
-- 3) Pendência auditável quando não há prova — nunca um usuário inventado.
--
-- Idempotente e reversível. Não toca relé, bomba, automação, comando local,
-- WhatsApp válido, FASE 2, licença, agente, OTA nem Setor Técnico.
-- ============================================================================

-- ── 1) AUDITORIA DURÁVEL DE COMANDOS (append-only) ──────────────────────────
CREATE TABLE IF NOT EXISTS public.command_audit (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id      uuid NOT NULL,
  client_event_id uuid,
  farm_id         uuid NOT NULL,
  equipment_id    uuid,
  equipment_name  text,
  -- AUTORIA (os quatro campos que nunca podem ser perdidos)
  user_id         uuid,
  user_email      text,
  actor_label     text,
  origin_kind     text,          -- panel | whatsapp | api | automation | system
  -- INTENÇÃO e resultado
  intent          text,          -- turn_on | turn_off
  frame           text,
  source_device   text,
  status_final    text,
  command_created_at timestamptz,
  sent_at         timestamptz,
  responded_at    timestamptz,
  captured_at     timestamptz NOT NULL DEFAULT now(),
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT command_audit_command_uniq UNIQUE (command_id)
);
CREATE INDEX IF NOT EXISTS idx_cmd_audit_farm_time ON public.command_audit (farm_id, command_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cmd_audit_equip_time ON public.command_audit (equipment_id, command_created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cmd_audit_client_event ON public.command_audit (client_event_id) WHERE client_event_id IS NOT NULL;

ALTER TABLE public.command_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cmd_audit_select ON public.command_audit;
CREATE POLICY cmd_audit_select ON public.command_audit
  FOR SELECT TO authenticated USING (public.has_farm_access(auth.uid(), farm_id));
-- Sem policy de INSERT/UPDATE/DELETE: só o trigger SECURITY DEFINER escreve.

COMMENT ON TABLE public.command_audit IS
  'Autoria durável dos comandos. Escrita na conclusão e antes de qualquer DELETE em commands. Fonte de verdade de "quem mandou" — independente do ciclo de vida de commands.';

-- Classificação da procedência do comando, sem citar pessoas.
CREATE OR REPLACE FUNCTION public.classify_command_origin_kind(_source_device text, _created_by uuid)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN lower(COALESCE(_source_device,'')) LIKE 'whatsapp%'        THEN 'whatsapp'
    WHEN lower(COALESCE(_source_device,'')) LIKE 'cloud-automation%' THEN 'automation'
    WHEN lower(COALESCE(_source_device,'')) LIKE 'backend-reset%'   THEN 'system'
    WHEN _created_by IS NOT NULL                                    THEN 'panel'
    ELSE 'system'
  END;
$$;

CREATE OR REPLACE FUNCTION public.capture_command_audit()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  c public.commands%ROWTYPE;
  v_email text; v_name text; v_equip text;
BEGIN
  c := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  IF c.id IS NULL OR c.farm_id IS NULL THEN RETURN CASE WHEN TG_OP='DELETE' THEN OLD ELSE NEW END; END IF;

  SELECT email, full_name INTO v_email, v_name FROM public.profiles WHERE id = c.created_by;
  SELECT name INTO v_equip FROM public.equipments WHERE id = c.equipment_id;

  INSERT INTO public.command_audit (
    command_id, client_event_id, farm_id, equipment_id, equipment_name,
    user_id, user_email, actor_label, origin_kind,
    intent, frame, source_device, status_final,
    command_created_at, sent_at, responded_at, details)
  VALUES (
    c.id, c.client_event_id, c.farm_id, c.equipment_id, v_equip,
    c.created_by, v_email,
    -- actor_label HUMANO: nome do perfil, e-mail, ou nada. Nunca rótulo técnico.
    NULLIF(btrim(COALESCE(v_name, v_email, '')), ''),
    public.classify_command_origin_kind(c.source_device, c.created_by),
    CASE WHEN c.frame ~ '\{0*1\}' THEN 'turn_on' ELSE 'turn_off' END,
    c.frame, c.source_device, c.status::text,
    c.created_at, c.sent_at, c.responded_at,
    jsonb_build_object('captured_on', TG_OP, 'command_type', c.type::text))
  ON CONFLICT (command_id) DO UPDATE SET
    -- só ENRIQUECE; autoria já registrada nunca é apagada por reprocesso
    user_id       = COALESCE(public.command_audit.user_id, EXCLUDED.user_id),
    user_email    = COALESCE(public.command_audit.user_email, EXCLUDED.user_email),
    actor_label   = COALESCE(public.command_audit.actor_label, EXCLUDED.actor_label),
    status_final  = COALESCE(EXCLUDED.status_final, public.command_audit.status_final),
    responded_at  = COALESCE(EXCLUDED.responded_at, public.command_audit.responded_at),
    sent_at       = COALESCE(EXCLUDED.sent_at, public.command_audit.sent_at);

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END; $$;

-- Captura em DOIS momentos: ao concluir (para existir mesmo sem delete) e ANTES
-- de qualquer DELETE (independente de quem apaga — trigger, cron ou manual).
DROP TRIGGER IF EXISTS trg_command_audit_on_finish ON public.commands;
CREATE TRIGGER trg_command_audit_on_finish
AFTER UPDATE OF status ON public.commands
FOR EACH ROW
WHEN (NEW.status::text IN ('executed','timeout','error','cancelled','delivered'))
EXECUTE FUNCTION public.capture_command_audit();

DROP TRIGGER IF EXISTS trg_command_audit_before_delete ON public.commands;
CREATE TRIGGER trg_command_audit_before_delete
BEFORE DELETE ON public.commands
FOR EACH ROW EXECUTE FUNCTION public.capture_command_audit();

-- ── 2) PENDÊNCIA AUDITÁVEL (quando não há prova) ────────────────────────────
CREATE TABLE IF NOT EXISTS public.authorship_pending_review (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id           uuid NOT NULL,
  automation_log_id uuid NOT NULL,
  equipment_id      uuid,
  equipment_name    text,
  occurred_at       timestamptz,
  origin            text,
  reason            text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  resolved_at       timestamptz,
  resolved_by       uuid,
  CONSTRAINT authorship_pending_uniq UNIQUE (automation_log_id)
);
CREATE INDEX IF NOT EXISTS idx_apr_farm ON public.authorship_pending_review (farm_id, occurred_at DESC) WHERE resolved_at IS NULL;
ALTER TABLE public.authorship_pending_review ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS apr_select ON public.authorship_pending_review;
CREATE POLICY apr_select ON public.authorship_pending_review
  FOR SELECT TO authenticated USING (public.has_farm_access(auth.uid(), farm_id));

-- ── 3) HELPERS DE EVIDÊNCIA ─────────────────────────────────────────────────
-- O UUID é a evidência. Nome de pessoa isolado NUNCA atribui autoria.
CREATE OR REPLACE FUNCTION public.parse_user_uuid(_text text)
RETURNS uuid LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE m text;
BEGIN
  m := substring(COALESCE(_text,'') from 'user:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})');
  IF m IS NULL THEN RETURN NULL; END IF;
  RETURN m::uuid;
EXCEPTION WHEN OTHERS THEN RETURN NULL;
END; $$;

-- ── 4) RELATÓRIO DE IMPACTO por fazenda ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.automation_log_authorship_report (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                     uuid NOT NULL,
  run_at                     timestamptz NOT NULL DEFAULT now(),
  farm_id                    uuid NOT NULL,
  farm_name                  text,
  remotos_total              int NOT NULL DEFAULT 0,
  com_autor_ok               int NOT NULL DEFAULT 0,
  recuperados_command_audit  int NOT NULL DEFAULT 0,
  recuperados_details        int NOT NULL DEFAULT 0,
  recuperados_last_changed_by int NOT NULL DEFAULT 0,
  pendencias                 int NOT NULL DEFAULT 0,
  rotulos_tecnicos_removidos int NOT NULL DEFAULT 0,
  ruido_excluido             int NOT NULL DEFAULT 0
);
ALTER TABLE public.automation_log_authorship_report ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS alar_select ON public.automation_log_authorship_report;
CREATE POLICY alar_select ON public.automation_log_authorship_report
  FOR SELECT TO authenticated USING (public.has_farm_access(auth.uid(), farm_id));

-- ── 5) BACKFILL GLOBAL — todas as fazendas, todo o histórico ────────────────
-- Hierarquia de evidência, da mais forte para a mais fraca. Para em qualquer
-- degrau que resolva; se nenhum resolver, gera pendência. Idempotente:
-- só toca linhas remotas SEM user_id.
CREATE OR REPLACE FUNCTION public.backfill_automation_log_authorship(_run_id uuid DEFAULT gen_random_uuid())
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n int;
BEGIN
  -- 5.0 rótulo técnico nunca ocupa a coluna Usuário (vale p/ qualquer origem)
  UPDATE public.automation_log
     SET actor_label = NULL,
         details = COALESCE(details,'{}'::jsonb)
                   || jsonb_build_object('confirmation_method', actor_label,
                                         'authorship_backfill_run', _run_id)
   WHERE action IN ('turn_on','turn_off','pump_on','pump_off')
     AND public.is_technical_actor_label(actor_label);

  -- 5.1 PRIORIDADE 1 — vínculo explícito de comando → command_audit
  UPDATE public.automation_log al
     SET user_id     = ca.user_id,
         user_email  = COALESCE(al.user_email, ca.user_email),
         actor_label = COALESCE(NULLIF(btrim(al.actor_label),''), ca.actor_label),
         origin      = CASE WHEN ca.origin_kind IN ('whatsapp','panel','api')
                            THEN 'remote'::public.event_origin ELSE al.origin END,
         details     = COALESCE(al.details,'{}'::jsonb) || jsonb_build_object(
                         'authorship_source','command_audit',
                         'authorship_confidence','strong',
                         'authorship_backfill_run', _run_id,
                         'command_id', ca.command_id)
    FROM public.command_audit ca
   WHERE al.user_id IS NULL
     AND al.action IN ('turn_on','turn_off','pump_on','pump_off')
     AND ca.user_id IS NOT NULL
     AND ( (al.details->>'command_id') = ca.command_id::text
        OR (al.client_event_id IS NOT NULL AND al.client_event_id = ca.client_event_id) )
     AND al.farm_id = ca.farm_id;

  -- 5.2 PRIORIDADE 2 — user_id/e-mail em details, validados contra profiles
  UPDATE public.automation_log al
     SET user_id     = p.id,
         user_email  = COALESCE(al.user_email, p.email),
         actor_label = COALESCE(NULLIF(btrim(al.actor_label),''), p.full_name, p.email),
         details     = COALESCE(al.details,'{}'::jsonb) || jsonb_build_object(
                         'authorship_source','details_user',
                         'authorship_confidence','strong',
                         'authorship_backfill_run', _run_id)
    FROM public.profiles p
   WHERE al.user_id IS NULL
     AND al.action IN ('turn_on','turn_off','pump_on','pump_off')
     AND al.origin IN ('remote'::public.event_origin)
     AND ( p.id::text = al.details->>'user_id'
        OR (al.details->>'user_email' IS NOT NULL AND p.email = al.details->>'user_email') );

  -- 5.3 PRIORIDADE 3 — equipments.last_changed_by no formato "...|user:<UUID>"
  --     (formato real observado em produção, ex.: "Nome Sobrenome|user:<UUID>"
  --     com last_actuation_origin='remote-desired').
  --
  --     LIMITE SEMÂNTICO DECISIVO: last_changed_by é campo de ESTADO ATUAL —
  --     descreve SÓ a ÚLTIMA atuação daquele equipamento. Atribuir com ele todos
  --     os eventos remotos de uma janela creditaria à mesma pessoa atuações de
  --     terceiros. Por isso só o evento remoto MAIS RECENTE de cada equipamento
  --     pode ser atribuído por esta via; os anteriores viram pendência.
  --
  --     Exige ainda: procedência remota declarada, mesmo equipamento/fazenda,
  --     UUID existente em profiles e nenhum comando posterior de outro autor.
  --     O UUID é a prova; nome isolado nunca atribui.
  UPDATE public.automation_log al
     SET user_id     = p.id,
         user_email  = COALESCE(al.user_email, p.email),
         actor_label = COALESCE(NULLIF(btrim(al.actor_label),''), p.full_name, p.email),
         details     = COALESCE(al.details,'{}'::jsonb) || jsonb_build_object(
                         'authorship_source','last_changed_by_uuid',
                         'authorship_confidence','medium',
                         'authorship_backfill_run', _run_id)
    FROM public.equipments e
    JOIN public.profiles p ON p.id = public.parse_user_uuid(e.last_changed_by)
   WHERE al.user_id IS NULL
     AND al.action IN ('turn_on','turn_off','pump_on','pump_off')
     AND al.origin = 'remote'::public.event_origin
     AND al.equipment_id = e.id
     AND al.farm_id = e.farm_id
     AND lower(COALESCE(e.last_actuation_origin,'')) IN ('remote','remote-desired','remote-cmd','remote_desired','remote_cmd')
     -- só o evento remoto MAIS RECENTE do equipamento: é o único que
     -- last_changed_by de fato descreve
     AND al.id = (
       SELECT a2.id FROM public.automation_log a2
        WHERE a2.equipment_id = al.equipment_id
          AND a2.noise_reason IS NULL
          AND a2.action IN ('turn_on','turn_off','pump_on','pump_off')
          AND a2.origin = 'remote'::public.event_origin
        ORDER BY a2.occurred_at DESC, a2.created_at DESC, a2.id DESC
        LIMIT 1)
     -- teto de idade: um campo de estado atual não descreve história remota
     AND al.occurred_at > now() - interval '90 days'
     AND NOT EXISTS (
       SELECT 1 FROM public.command_audit ca2
        WHERE ca2.equipment_id = al.equipment_id
          AND ca2.command_created_at > al.occurred_at
          AND ca2.user_id IS DISTINCT FROM p.id);

  -- 5.4 PENDÊNCIA — remoto que nenhuma evidência resolveu. Nunca inventa.
  INSERT INTO public.authorship_pending_review
    (farm_id, automation_log_id, equipment_id, equipment_name, occurred_at, origin, reason)
  SELECT al.farm_id, al.id, al.equipment_id, al.equipment_name, al.occurred_at, al.origin::text,
         'sem evidência forte de autoria (command_audit, details ou user UUID em last_changed_by)'
    FROM public.automation_log al
   WHERE al.user_id IS NULL
     AND al.noise_reason IS NULL
     AND al.action IN ('turn_on','turn_off','pump_on','pump_off')
     AND al.origin = 'remote'::public.event_origin
  ON CONFLICT (automation_log_id) DO NOTHING;

  -- pendência resolvida por uma execução posterior deixa de ser pendência
  UPDATE public.authorship_pending_review r
     SET resolved_at = now()
    FROM public.automation_log al
   WHERE r.automation_log_id = al.id AND r.resolved_at IS NULL AND al.user_id IS NOT NULL;

  -- ── 5.5 RELATÓRIO DE IMPACTO por fazenda ──────────────────────────────────
  INSERT INTO public.automation_log_authorship_report (
    run_id, farm_id, farm_name, remotos_total, com_autor_ok,
    recuperados_command_audit, recuperados_details, recuperados_last_changed_by,
    pendencias, rotulos_tecnicos_removidos, ruido_excluido)
  SELECT _run_id, f.id, f.name,
    count(*) FILTER (WHERE al.origin = 'remote'::public.event_origin AND al.noise_reason IS NULL)::int,
    count(*) FILTER (WHERE al.origin = 'remote'::public.event_origin AND al.noise_reason IS NULL AND al.user_id IS NOT NULL)::int,
    count(*) FILTER (WHERE al.details->>'authorship_source' = 'command_audit')::int,
    count(*) FILTER (WHERE al.details->>'authorship_source' = 'details_user')::int,
    count(*) FILTER (WHERE al.details->>'authorship_source' = 'last_changed_by_uuid')::int,
    (SELECT count(*)::int FROM public.authorship_pending_review r
      WHERE r.farm_id = f.id AND r.resolved_at IS NULL),
    count(*) FILTER (WHERE (al.details->>'authorship_backfill_run')::text = _run_id::text
                       AND al.details ? 'confirmation_method')::int,
    count(*) FILTER (WHERE al.noise_reason IS NOT NULL)::int
  FROM public.farms f
  LEFT JOIN public.automation_log al
    ON al.farm_id = f.id AND al.action IN ('turn_on','turn_off','pump_on','pump_off')
  GROUP BY f.id, f.name;

  RETURN _run_id;
END; $$;

REVOKE ALL ON FUNCTION public.backfill_automation_log_authorship(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.backfill_automation_log_authorship(uuid) TO service_role;

-- ── 6) SEMEIA a auditoria com os comandos que ainda existem ─────────────────
INSERT INTO public.command_audit (
  command_id, client_event_id, farm_id, equipment_id, equipment_name,
  user_id, user_email, actor_label, origin_kind, intent, frame, source_device,
  status_final, command_created_at, sent_at, responded_at, details)
SELECT c.id, c.client_event_id, c.farm_id, c.equipment_id, e.name,
       c.created_by, p.email, NULLIF(btrim(COALESCE(p.full_name, p.email, '')), ''),
       public.classify_command_origin_kind(c.source_device, c.created_by),
       CASE WHEN c.frame ~ '\{0*1\}' THEN 'turn_on' ELSE 'turn_off' END,
       c.frame, c.source_device, c.status::text,
       c.created_at, c.sent_at, c.responded_at,
       jsonb_build_object('captured_on','seed')
  FROM public.commands c
  LEFT JOIN public.equipments e ON e.id = c.equipment_id
  LEFT JOIN public.profiles   p ON p.id = c.created_by
ON CONFLICT (command_id) DO NOTHING;

-- ── 7) EXECUTA o backfill global ────────────────────────────────────────────
SELECT public.backfill_automation_log_authorship();

-- ============================================================================
-- CONFERÊNCIA GLOBAL POR FAZENDA (rodar depois):
--   SELECT farm_name, remotos_total, com_autor_ok, recuperados_command_audit,
--          recuperados_details, recuperados_last_changed_by, pendencias,
--          rotulos_tecnicos_removidos, ruido_excluido
--     FROM public.automation_log_authorship_report
--    WHERE run_id = (SELECT run_id FROM public.automation_log_authorship_report
--                     ORDER BY run_at DESC LIMIT 1)
--    ORDER BY farm_name;
--   -- pendências para revisão administrativa:
--   SELECT * FROM public.authorship_pending_review WHERE resolved_at IS NULL;
--
-- ROLLBACK (só do que ESTE backfill escreveu; nada foi apagado):
--   UPDATE public.automation_log
--      SET user_id = NULL, user_email = NULL, actor_label = NULL
--    WHERE details ? 'authorship_source';
-- ============================================================================
