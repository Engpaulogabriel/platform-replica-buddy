CREATE OR REPLACE FUNCTION public.reconcile_cfg_response_from_agent_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _tsnn text;
  _cmd_id uuid;
BEGIN
  IF NEW.category <> 'rx' OR NEW.raw_frame IS NULL THEN
    RETURN NEW;
  END IF;

  _tsnn := substring(NEW.raw_frame from '^_\[(\d{4})_[A-Z_]+_\]\{');

  IF _tsnn IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT c.id
    INTO _cmd_id
  FROM public.commands c
  WHERE c.farm_id = NEW.farm_id
    AND c.type = 'config'
    AND COALESCE(c.plc_hw_id, substring(c.frame from '^\[(\d{4})_CFG_\]')) = _tsnn
    AND c.status IN ('pending', 'sent', 'timeout')
    AND COALESCE(c.sent_at, c.created_at) BETWEEN (NEW.created_at - interval '90 seconds') AND (NEW.created_at + interval '10 seconds')
  ORDER BY COALESCE(c.sent_at, c.created_at) DESC
  LIMIT 1;

  IF _cmd_id IS NOT NULL THEN
    UPDATE public.commands
       SET status = 'executed',
           response = NEW.raw_frame,
           error_message = NULL,
           responded_at = COALESCE(NEW.created_at, now())
     WHERE id = _cmd_id
       AND status IN ('pending', 'sent', 'timeout');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reconcile_cfg_response_from_agent_log_trigger ON public.agent_logs;

CREATE TRIGGER reconcile_cfg_response_from_agent_log_trigger
AFTER INSERT ON public.agent_logs
FOR EACH ROW
EXECUTE FUNCTION public.reconcile_cfg_response_from_agent_log();