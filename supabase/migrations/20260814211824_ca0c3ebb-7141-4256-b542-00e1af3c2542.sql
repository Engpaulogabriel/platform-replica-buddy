CREATE TABLE IF NOT EXISTS public.technical_display_prefs (
  user_id             uuid PRIMARY KEY,
  show_technical_times boolean NOT NULL DEFAULT false,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.technical_display_prefs IS
  'Preferências de exibição técnica por usuário. Desligado por padrão. Só surte efeito para platform_admin/platform_support.';

GRANT SELECT, INSERT, UPDATE ON public.technical_display_prefs TO authenticated;
GRANT ALL ON public.technical_display_prefs TO service_role;

ALTER TABLE public.technical_display_prefs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tdp_select ON public.technical_display_prefs;
CREATE POLICY tdp_select ON public.technical_display_prefs
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() AND public.is_platform_staff(auth.uid()));

DROP POLICY IF EXISTS tdp_insert ON public.technical_display_prefs;
CREATE POLICY tdp_insert ON public.technical_display_prefs
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() AND public.is_platform_staff(auth.uid()));

DROP POLICY IF EXISTS tdp_update ON public.technical_display_prefs;
CREATE POLICY tdp_update ON public.technical_display_prefs
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid() AND public.is_platform_staff(auth.uid()))
  WITH CHECK (user_id = auth.uid() AND public.is_platform_staff(auth.uid()));

CREATE OR REPLACE FUNCTION public.set_technical_display_pref(
  _show boolean, _actor uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_actor uuid := COALESCE(_actor, auth.uid());
BEGIN
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'sem usuário autenticado';
  END IF;
  IF NOT public.is_platform_staff(v_actor) THEN
    RAISE EXCEPTION 'somente platform_admin ou técnico (platform_support) pode alterar esta preferência';
  END IF;

  INSERT INTO public.technical_display_prefs (user_id, show_technical_times, updated_at)
  VALUES (v_actor, COALESCE(_show,false), now())
  ON CONFLICT (user_id) DO UPDATE
    SET show_technical_times = EXCLUDED.show_technical_times,
        updated_at = now();

  RETURN COALESCE(_show,false);
END; $$;
GRANT EXECUTE ON FUNCTION public.set_technical_display_pref(boolean, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_technical_display_pref(_actor uuid DEFAULT NULL)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT p.show_technical_times
       FROM public.technical_display_prefs p
      WHERE p.user_id = COALESCE(_actor, auth.uid())
        AND public.is_platform_staff(COALESCE(_actor, auth.uid()))),
    false);
$$;
GRANT EXECUTE ON FUNCTION public.get_technical_display_pref(uuid) TO authenticated, service_role;

ALTER TABLE public.technical_display_prefs REPLICA IDENTITY FULL;
DO $$ BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.technical_display_prefs;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;