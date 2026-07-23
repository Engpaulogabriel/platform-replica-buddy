REVOKE ALL ON FUNCTION public.get_energy_efficiency_summary(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_energy_efficiency_summary(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_energy_efficiency_summary(uuid) TO authenticated;