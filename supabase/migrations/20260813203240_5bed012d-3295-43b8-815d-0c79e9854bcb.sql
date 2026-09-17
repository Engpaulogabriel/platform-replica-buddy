CREATE OR REPLACE FUNCTION public.attribute_scheduled_shutdown_log()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
DECLARE
  v_rule text;
  v_brt timestamp;
  v_now_min int;
  v_dow text;
BEGIN
  IF NEW.action IN ('pump_off', 'turn_off') AND NEW.origin IN ('local', 'system') THEN
    v_brt := (now() AT TIME ZONE 'America/Bahia');
    v_now_min := (extract(hour from v_brt)::int) * 60 + (extract(minute from v_brt)::int);
    v_dow := (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[(extract(dow from v_brt)::int) + 1];

    SELECT sa.name INTO v_rule
    FROM public.scheduled_automations sa
    WHERE sa.farm_id = NEW.farm_id AND sa.is_active = true
      AND v_dow = ANY(sa.days_of_week)
      AND v_now_min >= ((substring(sa.time_brt from '^([0-9]{1,2})')::int) * 60 + (substring(sa.time_brt from ':([0-9]{2})')::int)) - 5
      AND v_now_min <= ((substring(sa.time_brt from '^([0-9]{1,2})')::int) * 60 + (substring(sa.time_brt from ':([0-9]{2})')::int)) + 25
    LIMIT 1;

    IF v_rule IS NOT NULL THEN
      NEW.origin := 'auto';
      NEW.actor_label := v_rule;
    END IF;
  END IF;
  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_attribute_scheduled_shutdown ON public.automation_log;
CREATE TRIGGER trg_attribute_scheduled_shutdown
  BEFORE INSERT ON public.automation_log
  FOR EACH ROW EXECUTE FUNCTION public.attribute_scheduled_shutdown_log();