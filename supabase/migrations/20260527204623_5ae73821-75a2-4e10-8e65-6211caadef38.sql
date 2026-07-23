CREATE OR REPLACE FUNCTION public.can_write_farm(_user_id uuid, _farm_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    public.is_platform_admin(_user_id)
    OR EXISTS (
      SELECT 1 FROM public.user_roles
      WHERE user_id = _user_id AND farm_id = _farm_id
        AND role IN ('owner','admin','operator','supervisor')
    )
    OR (
      public.is_platform_support(_user_id)
      AND EXISTS (SELECT 1 FROM public.farms WHERE id = _farm_id AND is_demo = true)
    );
$function$;