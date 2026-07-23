-- 1) Drop overly-permissive SELECT policy on whatsapp_groups
DROP POLICY IF EXISTS wa_groups_select_authenticated ON public.whatsapp_groups;

-- 2) Fix mutable search_path on _eq_output_on
ALTER FUNCTION public._eq_output_on(text, integer) SET search_path = public, pg_temp;