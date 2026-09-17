CREATE TABLE IF NOT EXISTS public.phase_b_run_results (
  id bigserial PRIMARY KEY,
  step text NOT NULL,
  run_id uuid,
  numbers jsonb NOT NULL DEFAULT '{}'::jsonb,
  executed_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.phase_b_run_results TO authenticated;
GRANT ALL ON public.phase_b_run_results TO service_role;
ALTER TABLE public.phase_b_run_results ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS phase_b_run_results_select ON public.phase_b_run_results;
CREATE POLICY phase_b_run_results_select ON public.phase_b_run_results
  FOR SELECT TO authenticated USING (public.is_platform_staff(auth.uid()));

DO $do$
DECLARE c record; f record; v_run uuid := gen_random_uuid(); v_n int;
BEGIN
  SELECT * INTO c FROM public.run_phase_b_cleanup();
  INSERT INTO public.phase_b_run_results (step, run_id, numbers)
  VALUES ('run_phase_b_cleanup', c.run_id,
          jsonb_build_object('tecnicos', c.tecnicos, 'nao_confirmados', c.nao_confirmados,
                             'duplicidades', c.duplicidades));

  SELECT * INTO f FROM public.finalize_origin_and_authorship(v_run);
  INSERT INTO public.phase_b_run_results (step, run_id, numbers)
  VALUES ('finalize_origin_and_authorship', v_run,
          jsonb_build_object('corrigidos', f.corrigidos, 'enfileirados', f.enfileirados));

  v_n := public.mark_corroborated_candidates(v_run);
  INSERT INTO public.phase_b_run_results (step, run_id, numbers)
  VALUES ('mark_corroborated_candidates', v_run, jsonb_build_object('lotes', v_n));
END $do$;