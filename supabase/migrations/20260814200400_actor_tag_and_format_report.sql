-- ============================================================================
-- FORMATO DE AUTORIA EM equipments.last_changed_by — diagnóstico + produtores
-- ----------------------------------------------------------------------------
-- CONTEXTO (verificado no código, não suposto):
--   • O PAINEL/API não grava last_changed_by. Ele cria `commands` com
--     created_by — autoria já coberta pela PRIORIDADE 1 (command_audit).
--   • O WHATSAPP grava só o NOME (`op.name ?? phone`), porque
--     whatsapp_operators NÃO tem vínculo com usuário da plataforma.
--   • A AUTOMAÇÃO grava o nome da REGRA (ex.: "Desligamento 17h") — corretamente
--     não é pessoa, e não deve virar autoria remota.
--   → Hoje NENHUM produtor grava "|user:<UUID>". Esta migration cria o que falta
--     para que passe a gravar, sem inventar UUID onde não existe.
--
-- 1) Relatório de formatos (responde "quantos por formato", por fazenda).
-- 2) build_actor_tag(): monta "Nome|user:<UUID>" só quando há UUID real.
-- 3) whatsapp_operators.user_id: o vínculo que falta para o WhatsApp ter UUID.
--
-- Idempotente. Não toca relé, bomba, automação, comando, FASE 2, agente ou OTA.
-- ============================================================================

-- ── 1) RELATÓRIO DE FORMATOS (read-only) ────────────────────────────────────
-- Responde objetivamente: quantos contêm |user:<UUID> válido, quantos são só
-- nome, quantos são nulos/outro formato — por fazenda e no total.
CREATE OR REPLACE FUNCTION public.last_changed_by_format_report()
RETURNS TABLE (
  farm_id uuid, farm_name text,
  total int, com_user_uuid int, uuid_valido_em_profiles int,
  somente_nome int, nulo_ou_vazio int
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT f.id, f.name,
    count(e.id)::int,
    count(*) FILTER (WHERE public.parse_user_uuid(e.last_changed_by) IS NOT NULL)::int,
    count(*) FILTER (WHERE EXISTS (
      SELECT 1 FROM public.profiles p WHERE p.id = public.parse_user_uuid(e.last_changed_by)))::int,
    count(*) FILTER (WHERE COALESCE(btrim(e.last_changed_by),'') <> ''
                       AND public.parse_user_uuid(e.last_changed_by) IS NULL)::int,
    count(*) FILTER (WHERE COALESCE(btrim(e.last_changed_by),'') = '')::int
  FROM public.farms f
  LEFT JOIN public.equipments e ON e.farm_id = f.id
  GROUP BY f.id, f.name
  ORDER BY f.name;
$$;

GRANT EXECUTE ON FUNCTION public.last_changed_by_format_report() TO authenticated, service_role;

COMMENT ON FUNCTION public.last_changed_by_format_report() IS
  'Contagem de equipments.last_changed_by por formato, por fazenda. Use antes de confiar na PRIORIDADE 3 do backfill de autoria.';

-- ── 2) MONTAGEM PADRÃO DA ETIQUETA DE AUTOR ────────────────────────────────
-- "Nome Humano|user:<UUID>" quando há usuário real; só o nome quando não há.
-- NUNCA inventa UUID: sem user_id, devolve apenas o nome (e o backfill tratará
-- como evidência insuficiente para autoria remota).
CREATE OR REPLACE FUNCTION public.build_actor_tag(_name text, _user_id uuid)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN _user_id IS NULL THEN NULLIF(btrim(COALESCE(_name,'')), '')
    ELSE COALESCE(NULLIF(btrim(COALESCE(_name,'')), ''), 'Usuário') || '|user:' || _user_id::text
  END;
$$;

COMMENT ON FUNCTION public.build_actor_tag(text, uuid) IS
  'Etiqueta padrão de autoria: "Nome|user:<UUID>". Sem user_id, devolve só o nome — nunca inventa UUID.';

-- ── 3) VÍNCULO QUE FALTA: operador de WhatsApp ↔ usuário da plataforma ──────
-- Sem esta coluna o WhatsApp não TEM UUID para gravar. Nullable de propósito:
-- operador sem vínculo continua funcionando, apenas sem autoria forte.
ALTER TABLE public.whatsapp_operators
  ADD COLUMN IF NOT EXISTS user_id uuid;

CREATE INDEX IF NOT EXISTS idx_wa_operators_user ON public.whatsapp_operators (user_id) WHERE user_id IS NOT NULL;

COMMENT ON COLUMN public.whatsapp_operators.user_id IS
  'Usuário da plataforma correspondente a este operador. Preenchido pelo admin. Enquanto NULL, comandos por WhatsApp não têm autoria forte (UUID) — o backfill os deixa como pendência em vez de inventar pessoa.';

-- ── 4) CONFERÊNCIA ──────────────────────────────────────────────────────────
--   SELECT * FROM public.last_changed_by_format_report();
--   SELECT count(*) FILTER (WHERE user_id IS NOT NULL) AS vinculados,
--          count(*) AS operadores
--     FROM public.whatsapp_operators;
-- ============================================================================
