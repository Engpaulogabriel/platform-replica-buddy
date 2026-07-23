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
    'total_farms', (SELECT count(*) FROM public.farms),
    'farms_lite', (SELECT count(*) FROM public.farms WHERE plan = 'lite'),
    'farms_pro', (SELECT count(*) FROM public.farms WHERE plan = 'pro'),
    'farms_suspended', (SELECT count(*) FROM public.farms WHERE license_key IS NULL),
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
    'total_equipments', (SELECT count(*) FROM public.equipments WHERE active),
    'total_users', (SELECT count(DISTINCT user_id) FROM public.user_roles),
    'pending_commands', (SELECT count(*) FROM public.commands WHERE status IN ('pending','sent'))
  );
END $function$;