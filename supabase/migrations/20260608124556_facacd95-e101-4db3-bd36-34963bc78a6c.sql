
-- Fix plc_groups.output_count to match actual equipment outputs
-- and auto-maintain via trigger on equipments insert/update.

UPDATE public.plc_groups g
SET output_count = sub.max_saida
FROM (
  SELECT plc_group_id, MAX(saida) AS max_saida
  FROM public.equipments
  WHERE plc_group_id IS NOT NULL AND saida IS NOT NULL
  GROUP BY plc_group_id
) sub
WHERE g.id = sub.plc_group_id
  AND sub.max_saida > g.output_count
  AND sub.max_saida BETWEEN 1 AND 6;

-- Trigger: keep output_count >= max(saida) whenever equipments change
CREATE OR REPLACE FUNCTION public.sync_plc_output_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _group uuid;
  _max smallint;
BEGIN
  _group := COALESCE(NEW.plc_group_id, OLD.plc_group_id);
  IF _group IS NULL THEN RETURN NEW; END IF;
  SELECT MAX(saida) INTO _max FROM public.equipments
    WHERE plc_group_id = _group AND saida IS NOT NULL;
  IF _max IS NOT NULL AND _max BETWEEN 1 AND 6 THEN
    UPDATE public.plc_groups
      SET output_count = _max
      WHERE id = _group AND output_count < _max;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_plc_output_count ON public.equipments;
CREATE TRIGGER trg_sync_plc_output_count
AFTER INSERT OR UPDATE OF saida, plc_group_id ON public.equipments
FOR EACH ROW EXECUTE FUNCTION public.sync_plc_output_count();
