DROP FUNCTION IF EXISTS public.platform_clear_pending_commands(uuid);

CREATE OR REPLACE FUNCTION public.platform_clear_pending_commands(_farm_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_count int;
BEGIN
  IF NOT public.is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden';
  END IF;

  UPDATE public.commands
  SET status = 'error'::public.command_status,
      responded_at = now(),
      error_message = COALESCE(error_message, 'Cancelado pelo painel da plataforma')
  WHERE farm_id = _farm_id
    AND status IN ('pending'::public.command_status, 'sent'::public.command_status);

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$function$;