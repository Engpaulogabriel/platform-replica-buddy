ALTER TABLE public.equipments ADD COLUMN IF NOT EXISTS alimenta_alt_id uuid REFERENCES public.equipments(id) ON DELETE SET NULL;

ALTER TABLE public.equipments DISABLE TRIGGER USER;

WITH f AS (SELECT id FROM public.farms WHERE name ILIKE '%semear%' LIMIT 1),
r AS (SELECT e.id, e.name FROM public.equipments e, f WHERE e.farm_id = f.id AND e.type = 'nivel')
UPDATE public.equipments e
SET alimenta_id = m.res_id, fonte_tipo = COALESCE(e.fonte_tipo, 'poco')
FROM (
  SELECT p.id AS poco_id, r.id AS res_id
  FROM public.equipments p, f, r
  WHERE p.farm_id = f.id AND p.type = 'poco'
    AND (
      (r.name ILIKE 'RESERVAT%01%' AND p.name ~ 'POÇO 0(1|2|7|8)') OR
      (r.name ILIKE 'RESERVAT%02%' AND p.name ~ 'POÇO (03|06|12|13)') OR
      (r.name ILIKE 'RESERVAT%03%' AND p.name ~ 'POÇO (05|14|15)') OR
      (r.name ILIKE 'RESERVAT%04%' AND p.name ~ 'POÇO (09|10|11|16)')
    )
) m
WHERE e.id = m.poco_id;

WITH f AS (SELECT id FROM public.farms WHERE name ILIKE '%semear%' LIMIT 1)
UPDATE public.equipments e
SET alimenta_id = (SELECT x.id FROM public.equipments x, f WHERE x.farm_id = f.id AND x.name ILIKE 'RESERVAT%01%' LIMIT 1),
    alimenta_alt_id = (SELECT x.id FROM public.equipments x, f WHERE x.farm_id = f.id AND x.name ILIKE 'RESERVAT%04%' LIMIT 1),
    fonte_tipo = COALESCE(e.fonte_tipo, 'poco')
FROM f
WHERE e.farm_id = f.id AND e.name ILIKE '%POÇO 04%';

ALTER TABLE public.equipments ENABLE TRIGGER USER;