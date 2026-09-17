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
  'Contagem de equipments.last_changed_by por formato, por fazenda.';

CREATE OR REPLACE FUNCTION public.build_actor_tag(_name text, _user_id uuid)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN _user_id IS NULL THEN NULLIF(btrim(COALESCE(_name,'')), '')
    ELSE COALESCE(NULLIF(btrim(COALESCE(_name,'')), ''), 'Usuário') || '|user:' || _user_id::text
  END;
$$;

COMMENT ON FUNCTION public.build_actor_tag(text, uuid) IS
  'Etiqueta padrão de autoria: "Nome|user:<UUID>". Sem user_id, devolve só o nome.';

ALTER TABLE public.whatsapp_operators
  ADD COLUMN IF NOT EXISTS user_id uuid;

CREATE INDEX IF NOT EXISTS idx_wa_operators_user ON public.whatsapp_operators (user_id) WHERE user_id IS NOT NULL;

COMMENT ON COLUMN public.whatsapp_operators.user_id IS
  'Usuário da plataforma correspondente a este operador. Enquanto NULL, comandos por WhatsApp não têm autoria forte.';