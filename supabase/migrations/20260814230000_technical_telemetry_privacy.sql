-- ============================================================================
-- PRIVACIDADE DA TELEMETRIA TÉCNICA — fonte sanitizada para o dashboard comum.
-- ----------------------------------------------------------------------------
-- Hoje o dashboard lê `equipments` direto e traz `last_communication` para
-- QUALQUER perfil com acesso à fazenda. O gate de tela já impede a exibição,
-- mas o dado continua viajando no payload. Esta migration entrega a fonte que
-- não expõe o timestamp.
--
-- NÃO altera relé, bomba, agente, rádio, OTA, FASE 2/3, automações, o Relatório
-- de Automação, a regra de Offline nem qualquer policy existente. Só ACRESCENTA
-- duas funções de leitura.
-- ============================================================================

-- ── 1) O helper único de autorização ────────────────────────────────────────
-- Usa os mecanismos REAIS do projeto. Não cria role nova: `app_role` do banco
-- (owner|admin|operator|viewer|supervisor) não tem técnico — quem é técnico
-- está em `platform_support`, exatamente como `is_platform_staff` já define.
CREATE OR REPLACE FUNCTION public.can_view_technical_telemetry(
  _user_id uuid, _farm_id uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    public.is_platform_admin(_user_id) OR public.is_platform_support(_user_id),
    false);
$$;
COMMENT ON FUNCTION public.can_view_technical_telemetry(uuid, uuid) IS
  'Única autorização para tempo/diagnóstico de comunicação: platform_admin ou técnico (platform_support). owner, admin de fazenda, supervisor, gestor, operador e viewer recebem false. _farm_id fica na assinatura para futura restrição por fazenda; hoje o acesso técnico é global à plataforma.';
GRANT EXECUTE ON FUNCTION public.can_view_technical_telemetry(uuid, uuid) TO authenticated, service_role;

-- ── 2) Fonte OPERACIONAL sanitizada ─────────────────────────────────────────
-- Devolve o que o card precisa para funcionar e NADA de diagnóstico:
--   • sem last_communication, last_polling_at, last_rx/tx, sinal, versão de
--     agente, porta COM, erro de bridge ou qualquer timestamp técnico;
--   • `is_offline` já vem CALCULADO no servidor, pela mesma regra de 15 min,
--     para a cor não depender do timestamp que estamos escondendo;
--   • `read_token` muda a cada nova leitura física e permite ao frontend
--     detectar "a bomba respondeu" sem saber QUANDO. É um hash — não dá para
--     voltar ao horário a partir dele.
CREATE OR REPLACE FUNCTION public.dashboard_equipment_operational(_farm_id uuid)
RETURNS TABLE (
  id                 uuid,
  name               text,
  running            boolean,
  desired_running    boolean,
  is_offline         boolean,
  is_unstable        boolean,
  actuation_origin   text,
  maintenance_mode   boolean,
  switching_locked   boolean,
  read_token         text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    e.id,
    e.name,
    COALESCE(e.last_outputs_state, '') ~ '1'                        AS running,
    e.desired_running,
    -- MESMA regra de Offline de hoje (15 minutos). O que sai do payload é o
    -- horário; o estado continua idêntico para todos os perfis.
    (e.last_communication IS NULL
      OR e.last_communication < now() - interval '15 minutes')      AS is_offline,
    (e.last_communication IS NOT NULL
      AND e.last_communication <  now() - interval '5 minutes'
      AND e.last_communication >= now() - interval '15 minutes')    AS is_unstable,
    e.last_actuation_origin,
    COALESCE(e.maintenance_mode, false),
    (e.command_blocked_until IS NOT NULL AND now() < e.command_blocked_until),
    -- token opaco e estável: mesma leitura → mesmo token; leitura nova → outro.
    md5(COALESCE(e.last_communication::text, '') || '|' ||
        COALESCE(e.last_outputs_state, ''))                          AS read_token
  FROM public.equipments e
  WHERE e.farm_id = _farm_id
    AND e.active = true
    AND public.has_farm_access(auth.uid(), e.farm_id)   -- mesma RLS de sempre
  ORDER BY e.name;
$$;
COMMENT ON FUNCTION public.dashboard_equipment_operational(uuid) IS
  'Payload do dashboard SEM diagnóstico: sem timestamps, sem sinal, sem bridge. is_offline vem calculado (regra de 15 min) e read_token permite detectar nova leitura sem revelar o horário. O dashboard técnico continua podendo ler equipments direto.';
GRANT EXECUTE ON FUNCTION public.dashboard_equipment_operational(uuid) TO authenticated, service_role;

-- ============================================================================
-- CONFERÊNCIA
--   SELECT public.can_view_technical_telemetry('<uuid do admin>');   -- true
--   SELECT public.can_view_technical_telemetry('<uuid de um owner>'); -- false
--   SELECT * FROM public.dashboard_equipment_operational('<farm_id>');
--   -- nenhuma coluna de horário deve aparecer no resultado acima.
--
-- ROLLBACK:
--   DROP FUNCTION IF EXISTS public.dashboard_equipment_operational(uuid);
--   DROP FUNCTION IF EXISTS public.can_view_technical_telemetry(uuid, uuid);
-- ============================================================================
