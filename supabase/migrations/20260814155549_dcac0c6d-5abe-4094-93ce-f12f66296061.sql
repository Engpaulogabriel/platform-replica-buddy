CREATE OR REPLACE FUNCTION public.master_manages_farm(_uid uuid, _farm_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.master_managers mm
    JOIN public.master_manager_farms mmf ON mmf.manager_id = mm.id
    WHERE mm.user_id = _uid
      AND mm.status = 'active'
      AND mmf.farm_id = _farm_id
  );
$function$;