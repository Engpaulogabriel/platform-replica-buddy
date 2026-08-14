-- ============================================================================
-- CONSULTA CANÔNICA do Relatório de Automação.
-- ----------------------------------------------------------------------------
-- Tela, CSV e PDF passam a consumir ESTA função. Não existe mais transformação
-- de rótulo no frontend: origem e usuário chegam prontos e iguais nos três.
--
-- Regras embutidas:
--   • só linha oficial (noise_reason IS NULL) — o guarda da Fase B já mantém
--     polling/eco/retry/boot/status_read e falha/timeout fora daqui;
--   • Remoto  → nome real da pessoa autenticada;
--   • Local   → 'Acionamento local';
--   • Automação → nome da regra;
--   • nenhum texto genérico: sem 'Desconhecido', 'Autoria histórica em
--     revisão', 'Origem em apuração', 'Comando Remoto', 'Telemetria RF',
--     'Sistema', 'RF', 'Bridge' ou 'Serial'.
--   • sem coluna de resultado: se a linha existe, houve transição física.
--
-- O `id` volta para permitir paridade verificável entre os formatos, mas é uso
-- INTERNO — tela e PDF do cliente não o exibem.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.automation_report_canonical(
  _farm_id uuid, _from timestamptz DEFAULT NULL, _to timestamptz DEFAULT NULL)
RETURNS TABLE (
  id            uuid,
  occurred_at   timestamptz,
  data_brt      text,
  hora_brt      text,
  equipamento   text,
  acao          text,      -- 'Ligada' | 'Desligada'
  origem        text,      -- 'Remoto' | 'Local' | 'Automação'
  usuario       text       -- nome real | 'Acionamento local' | nome da regra
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    al.id,
    al.occurred_at,
    to_char(al.occurred_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY'),
    to_char(al.occurred_at AT TIME ZONE 'America/Sao_Paulo', 'HH24:MI:SS'),
    COALESCE(al.equipment_name, e.name),
    CASE WHEN al.action IN ('turn_on','pump_on') THEN 'Ligada' ELSE 'Desligada' END,
    CASE al.origin
      WHEN 'remote'::public.event_origin THEN 'Remoto'
      WHEN 'local'::public.event_origin  THEN 'Local'
      WHEN 'auto'::public.event_origin   THEN 'Automação'
    END,
    CASE al.origin
      -- Remoto: SÓ o nome humano. Nunca método técnico, nunca rótulo genérico.
      WHEN 'remote'::public.event_origin THEN
        COALESCE(NULLIF(btrim(al.actor_label),''),
                 (SELECT p.full_name FROM public.profiles p WHERE p.id = al.user_id),
                 al.user_email)
      WHEN 'local'::public.event_origin  THEN 'Acionamento local'
      WHEN 'auto'::public.event_origin   THEN NULLIF(btrim(al.actor_label),'')
    END
  FROM public.automation_log al
  LEFT JOIN public.equipments e ON e.id = al.equipment_id
  WHERE al.farm_id = _farm_id
    AND al.noise_reason IS NULL                     -- só transição confirmada
    AND al.action IN ('turn_on','turn_off','pump_on','pump_off')
    AND al.origin IN ('remote'::public.event_origin,
                      'local'::public.event_origin,
                      'auto'::public.event_origin)
    AND (_from IS NULL OR al.occurred_at >= _from)
    AND (_to   IS NULL OR al.occurred_at <  _to)
    AND public.has_farm_access(auth.uid(), al.farm_id)
  ORDER BY al.occurred_at DESC, al.created_at DESC, al.id DESC;
$$;
GRANT EXECUTE ON FUNCTION public.automation_report_canonical(uuid, timestamptz, timestamptz)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.automation_report_canonical(uuid, timestamptz, timestamptz) IS
  'Fonte ÚNICA do Relatório de Automação: tela, CSV e PDF consomem esta função. Sem coluna de resultado, sem rótulo genérico, sem autoria inventada.';

-- ── Validação: os textos proibidos têm de dar ZERO ──────────────────────────
CREATE OR REPLACE FUNCTION public.automation_report_forbidden_text_count(_farm_id uuid DEFAULT NULL)
RETURNS TABLE (fazenda text, linhas bigint, textos_proibidos bigint, usuario_vazio bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT f.name, count(r.id),
         count(r.id) FILTER (WHERE lower(COALESCE(r.usuario,'') || ' ' || COALESCE(r.origem,'')) ~
           '(desconhecido|autoria hist|origem em apura|comando remoto|telemetria rf|^rf$|bridge|serial|sistema)'),
         count(r.id) FILTER (WHERE COALESCE(btrim(r.usuario),'') = '')
    FROM public.farms f
    LEFT JOIN LATERAL public.automation_report_canonical(f.id) r ON true
   WHERE (_farm_id IS NULL OR f.id = _farm_id)
   GROUP BY f.id, f.name ORDER BY f.name;
$$;
GRANT EXECUTE ON FUNCTION public.automation_report_forbidden_text_count(uuid) TO authenticated, service_role;

-- ── Inventário por fazenda: remotos oficiais com nome humano real ───────────
CREATE OR REPLACE FUNCTION public.remote_authorship_inventory()
RETURNS TABLE (
  fazenda text, remotos_oficiais bigint, com_nome_humano bigint,
  sem_nome bigint, locais bigint, automacoes bigint, pendentes_admin bigint
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT f.name,
    count(r.id) FILTER (WHERE r.origem = 'Remoto'),
    count(r.id) FILTER (WHERE r.origem = 'Remoto' AND COALESCE(btrim(r.usuario),'') <> ''),
    count(r.id) FILTER (WHERE r.origem = 'Remoto' AND COALESCE(btrim(r.usuario),'') = ''),
    count(r.id) FILTER (WHERE r.origem = 'Local'),
    count(r.id) FILTER (WHERE r.origem = 'Automação'),
    (SELECT count(*) FROM public.authorship_pending_review pr
      WHERE pr.farm_id = f.id AND pr.resolved_at IS NULL)
  FROM public.farms f
  LEFT JOIN LATERAL public.automation_report_canonical(f.id) r ON true
  GROUP BY f.id, f.name ORDER BY f.name;
$$;
GRANT EXECUTE ON FUNCTION public.remote_authorship_inventory() TO authenticated, service_role;

-- ── Lista técnica: históricos com autoria realmente irrecuperável ───────────
-- Restrita ao Setor Técnico. Nada aqui é alterado por suposição.
CREATE OR REPLACE FUNCTION public.irrecoverable_authorship_list()
RETURNS TABLE (
  fazenda text, equipamento text, evento_id uuid, ocorrido_brt text,
  acao text, motivo text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT f.name, al.equipment_name, al.id,
         to_char(al.occurred_at AT TIME ZONE 'America/Sao_Paulo','DD/MM/YYYY HH24:MI:SS'),
         CASE WHEN al.action IN ('turn_on','pump_on') THEN 'Ligada' ELSE 'Desligada' END,
         'transição física confirmada, sem prova de autoria em nenhuma fonte'
    FROM public.automation_log al
    JOIN public.farms f ON f.id = al.farm_id
   WHERE al.noise_reason = 'pending_authorship_review'
     AND public.is_platform_staff(auth.uid())
   ORDER BY f.name, al.occurred_at DESC;
$$;
GRANT EXECUTE ON FUNCTION public.irrecoverable_authorship_list() TO authenticated, service_role;

-- ============================================================================
-- VALIDAÇÃO
--   SELECT * FROM public.automation_report_forbidden_text_count();  -- tudo 0
--   SELECT * FROM public.remote_authorship_inventory();             -- sem_nome 0
--   SELECT * FROM public.irrecoverable_authorship_list();           -- técnico
-- ============================================================================
