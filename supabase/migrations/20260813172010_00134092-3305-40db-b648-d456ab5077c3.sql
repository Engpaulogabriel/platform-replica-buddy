CREATE OR REPLACE FUNCTION public.dms_to_decimal(p_dms text)
RETURNS numeric LANGUAGE plpgsql IMMUTABLE SET search_path = public AS $$
DECLARE
  m text[];
  deg numeric; minute numeric; sec numeric; hemi text; val numeric;
BEGIN
  IF p_dms IS NULL THEN RETURN NULL; END IF;
  m := regexp_match(p_dms, '([0-9]+)[^0-9]+([0-9]+)[^0-9]+([0-9]+(?:[.,][0-9]+)?)[^0-9NSEWnsew]*([NSEWnsew])');
  IF m IS NULL THEN RETURN NULL; END IF;
  deg := m[1]::numeric;
  minute := m[2]::numeric;
  sec := replace(m[3], ',', '.')::numeric;
  hemi := upper(m[4]);
  val := deg + minute / 60.0 + sec / 3600.0;
  IF hemi IN ('S', 'W') THEN val := -val; END IF;
  RETURN val;
END; $$;

CREATE OR REPLACE FUNCTION public.haversine_m(
  lat1 numeric, lon1 numeric, lat2 numeric, lon2 numeric
) RETURNS numeric LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE
    WHEN lat1 IS NULL OR lon1 IS NULL OR lat2 IS NULL OR lon2 IS NULL THEN NULL
    ELSE 2 * 6371000 * asin(sqrt(
      power(sin(radians(lat2 - lat1) / 2), 2) +
      cos(radians(lat1)) * cos(radians(lat2)) *
      power(sin(radians(lon2 - lon1) / 2), 2)
    ))
  END;
$$;

WITH nearest AS (
  SELECT DISTINCT ON (w.id)
         w.id AS well_id,
         e.id AS equipment_id
  FROM public.water_permit_wells w
  JOIN public.water_permits p ON p.id = w.permit_id
  JOIN public.equipments e ON e.farm_id = p.farm_id
                          AND e.type = 'poco'
                          AND e.active = true
                          AND e.latitude IS NOT NULL
                          AND e.longitude IS NOT NULL
  WHERE p.farm_id IS NOT NULL
    AND public.dms_to_decimal(w.latitude) IS NOT NULL
    AND public.dms_to_decimal(w.longitude) IS NOT NULL
  ORDER BY w.id,
           public.haversine_m(
             public.dms_to_decimal(w.latitude), public.dms_to_decimal(w.longitude),
             e.latitude, e.longitude
           ) ASC
)
UPDATE public.water_permit_wells w
SET equipment_id = n.equipment_id
FROM nearest n
WHERE w.id = n.well_id
  AND w.equipment_id IS DISTINCT FROM n.equipment_id;