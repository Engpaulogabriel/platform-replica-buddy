ALTER TABLE public.flow_history ADD COLUMN IF NOT EXISTS flow_rate_m3h numeric DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_flow_history_farm_ts ON public.flow_history(farm_id, ts);
CREATE INDEX IF NOT EXISTS idx_flow_history_equipment_ts ON public.flow_history(equipment_id, ts);

CREATE OR REPLACE FUNCTION public.fn_log_flow_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.flow_total_m3 IS DISTINCT FROM OLD.flow_total_m3
     AND NEW.vazao_mode = 'real'
     AND NEW.flow_total_m3 > 0 THEN
    INSERT INTO public.flow_history (equipment_id, farm_id, ts, accum_m3, flow_rate_m3h)
    VALUES (NEW.id, NEW.farm_id, now(), NEW.flow_total_m3, COALESCE(NEW.flow_rate_m3h, 0));
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_flow_history ON public.equipments;
CREATE TRIGGER trg_log_flow_history
  AFTER UPDATE OF flow_total_m3 ON public.equipments
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_log_flow_history();