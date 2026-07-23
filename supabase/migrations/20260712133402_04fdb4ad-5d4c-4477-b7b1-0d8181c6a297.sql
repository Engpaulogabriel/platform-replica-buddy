-- Fix: sync_plc_output_count trigger contava equipamentos de leitura (nivel)
-- como saidas, inflando output_count. Filtrar SOMENTE tipos de saida controlavel:
-- poco, bombeamento. Tipos de leitura (nivel) e repetidor NAO contam.

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
    WHERE plc_group_id = _group
      AND saida IS NOT NULL
      AND type IN ('poco','bombeamento');
  IF _max IS NULL THEN
    _max := 1;
  END IF;
  IF _max BETWEEN 1 AND 6 THEN
    UPDATE public.plc_groups
      SET output_count = _max
      WHERE id = _group AND output_count <> _max;
  END IF;
  RETURN NEW;
END;
$$;

-- Recalcula output_count de todos os grupos considerando apenas saidas reais.
WITH real_outputs AS (
  SELECT plc_group_id, MAX(saida) AS max_saida
  FROM public.equipments
  WHERE plc_group_id IS NOT NULL
    AND saida IS NOT NULL
    AND type IN ('poco','bombeamento')
  GROUP BY plc_group_id
)
UPDATE public.plc_groups g
SET output_count = COALESCE(ro.max_saida, 1)
FROM real_outputs ro
WHERE g.id = ro.plc_group_id
  AND g.output_count IS DISTINCT FROM COALESCE(ro.max_saida, 1)
  AND COALESCE(ro.max_saida, 1) BETWEEN 1 AND 6;

-- Corrige grupos que ficaram com output_count > 1 mas nao tem nenhuma saida
-- controlavel cadastrada (so tinham nivel/repetidor).
UPDATE public.plc_groups g
SET output_count = 1
WHERE g.output_count <> 1
  AND NOT EXISTS (
    SELECT 1 FROM public.equipments e
    WHERE e.plc_group_id = g.id
      AND e.type IN ('poco','bombeamento')
      AND e.saida IS NOT NULL
  );