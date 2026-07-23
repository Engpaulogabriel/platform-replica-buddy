REVOKE ALL ON FUNCTION public.calculate_energy_efficiency_for_date(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.calculate_energy_efficiency_for_date(uuid, date) FROM anon;
REVOKE ALL ON FUNCTION public.calculate_energy_efficiency_for_date(uuid, date) FROM authenticated;

REVOKE ALL ON FUNCTION public.infer_pump_action_from_command_frame(text, smallint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.infer_pump_action_from_command_frame(text, smallint) FROM anon;
REVOKE ALL ON FUNCTION public.infer_pump_action_from_command_frame(text, smallint) FROM authenticated;

REVOKE ALL ON FUNCTION public.compute_energy_efficiency(uuid, date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.compute_energy_efficiency(uuid, date) FROM anon;
REVOKE ALL ON FUNCTION public.compute_all_energy_efficiency(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.compute_all_energy_efficiency(date) FROM anon;

GRANT EXECUTE ON FUNCTION public.get_energy_efficiency_history(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_energy_efficiency_summary(uuid) TO authenticated;