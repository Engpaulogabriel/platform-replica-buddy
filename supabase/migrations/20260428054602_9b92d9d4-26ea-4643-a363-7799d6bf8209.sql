CREATE OR REPLACE FUNCTION public.platform_overview_stats()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT public.is_platform_staff(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;
  RETURN jsonb_build_object(
    'total_farms', (SELECT count(*) FROM public.farms WHERE NOT is_demo),
    'farms_lite', (SELECT count(*) FROM public.farms WHERE plan = 'lite' AND NOT is_demo),
    'farms_pro', (SELECT count(*) FROM public.farms WHERE plan = 'pro' AND NOT is_demo),
    'farms_suspended', (SELECT count(*) FROM public.farms WHERE license_key IS NULL AND NOT is_demo),
    'agents_online', (
      SELECT count(*) FROM public.site_health s
      JOIN public.farms f ON f.id = s.farm_id
      WHERE s.last_heartbeat > now() - interval '5 minutes' AND NOT f.is_demo
    ),
    'agents_offline', (
      SELECT count(*) FROM public.farms f
      WHERE NOT f.is_demo AND NOT EXISTS (
        SELECT 1 FROM public.site_health s
        WHERE s.farm_id = f.id AND s.last_heartbeat > now() - interval '5 minutes'
      )
    ),
    'total_equipments', (
      SELECT count(*) FROM public.equipments e
      JOIN public.farms f ON f.id = e.farm_id
      WHERE e.active AND NOT f.is_demo
    ),
    'total_users', (
      SELECT count(DISTINCT ur.user_id) FROM public.user_roles ur
      JOIN public.farms f ON f.id = ur.farm_id
      WHERE NOT f.is_demo
    ),
    'pending_commands', (
      SELECT count(*) FROM public.commands c
      JOIN public.farms f ON f.id = c.farm_id
      WHERE c.status IN ('pending','sent') AND NOT f.is_demo
    )
  );
END $function$;