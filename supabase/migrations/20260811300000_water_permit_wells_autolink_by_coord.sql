-- ============================================================================
-- VÍNCULO AUTOMÁTICO DE POÇOS POR COORDENADA + VAZÃO POR OUTORGA
-- ----------------------------------------------------------------------------
-- Objetivo (pedido do usuário):
--   1. Converter as coordenadas DMS (texto) de water_permit_wells → decimal.
--   2. Comparar com latitude/longitude (decimais) dos equipamentos da MESMA
--      fazenda (equipments.type='poco', ativos).
--   3. Vincular cada poço da outorga (water_permit_wells.equipment_id) ao
--      equipamento mais PRÓXIMO da mesma fazenda, SEM limite de distância — o
--      GPS de campo da portaria pode divergir do GPS do sistema, mas é o mesmo
--      poço; então o mais próximo é sempre o correto.
--   4. Definir equipments.estimated_flow_m3h = flow_rate_m3_day /
--      regime_hours_per_day da outorga vinculada (500 m³/h p/ 25.560/27.368,
--      300 m³/h p/ 33.285/33.281/33.737 — regime = 18 h/dia).
--
-- Idempotente. Genérico (roda p/ qualquer fazenda com water_permits). Vincula
-- CADA poço ao equipamento mais próximo (sobrescreve vínculo anterior). Aplicar
-- via push (Lovable) ou SQL Editor.
--
-- Resultado validado offline (Semear, 2026-08-11) contra os equipamentos ao vivo:
--   BIJEÇÃO PERFEITA: os 16 poços da Semear casam 1:1 com os 16 equipamentos,
--   ZERO colisões (cada equipamento recebe exatamente 1 poço):
--       500 m³/h → POÇO 01 R1, 02 R1, 03 R2, 04 R1/R4, 15 R3  (25.560 / 27.368)
--       300 m³/h → POÇO 05,06,07,08,09,10,11,12,13,14,16      (33.285 / 33.281 / 33.737)
--   POÇO 10 R4 ← Poço 10 (33.285, ~394 m) e POÇO 16 R4 ← Poço 16 (33.285, ~902 m)
--   agora TAMBÉM vinculados (imprecisão de GPS de campo — é o mesmo poço).
--   Agronave (28.608) tem farm_id próprio/NULL → não casa com a Semear. OK.
-- ============================================================================

-- ── 1. DMS (texto) → decimal ────────────────────────────────────────────────
-- Aceita formatos "13°01'25,3\"S", "45°24'32\"W", "13°2'3,02\"S" (vírgula ou
-- ponto decimal; separadores ° ' \" ou quaisquer não-dígitos). Hemisfério S/W
-- → negativo. Retorna NULL se não parsear.
CREATE OR REPLACE FUNCTION public.dms_to_decimal(p_dms text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  m text[];
  deg numeric; minute numeric; sec numeric; hemi text; val numeric;
BEGIN
  IF p_dms IS NULL THEN RETURN NULL; END IF;
  m := regexp_match(
         p_dms,
         '([0-9]+)[^0-9]+([0-9]+)[^0-9]+([0-9]+(?:[.,][0-9]+)?)[^0-9NSEWnsew]*([NSEWnsew])'
       );
  IF m IS NULL THEN RETURN NULL; END IF;
  deg    := m[1]::numeric;
  minute := m[2]::numeric;
  sec    := replace(m[3], ',', '.')::numeric;
  hemi   := upper(m[4]);
  val    := deg + minute / 60.0 + sec / 3600.0;
  IF hemi IN ('S', 'W') THEN val := -val; END IF;
  RETURN val;
END;
$$;

-- ── 2. Distância haversine em metros ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.haversine_m(
  lat1 numeric, lon1 numeric, lat2 numeric, lon2 numeric
) RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN lat1 IS NULL OR lon1 IS NULL OR lat2 IS NULL OR lon2 IS NULL THEN NULL
    ELSE 2 * 6371000 * asin( sqrt(
      power(sin(radians(lat2 - lat1) / 2), 2) +
      cos(radians(lat1)) * cos(radians(lat2)) *
      power(sin(radians(lon2 - lon1) / 2), 2)
    ) )
  END;
$$;

-- ── 3. Vincula cada poço ao equipamento mais próximo (SEM limite de distância) ─
WITH nearest AS (
  SELECT DISTINCT ON (w.id)
         w.id  AS well_id,
         e.id  AS equipment_id,
         public.haversine_m(
           public.dms_to_decimal(w.latitude),  public.dms_to_decimal(w.longitude),
           e.latitude, e.longitude
         ) AS dist_m
  FROM public.water_permit_wells w
  JOIN public.water_permits p ON p.id = w.permit_id
  JOIN public.equipments   e ON e.farm_id = p.farm_id
                            AND e.type = 'poco'
                            AND e.active = true
                            AND e.latitude  IS NOT NULL
                            AND e.longitude IS NOT NULL
  WHERE p.farm_id IS NOT NULL
    AND public.dms_to_decimal(w.latitude)  IS NOT NULL
    AND public.dms_to_decimal(w.longitude) IS NOT NULL
  ORDER BY w.id,
           public.haversine_m(
             public.dms_to_decimal(w.latitude),  public.dms_to_decimal(w.longitude),
             e.latitude, e.longitude
           ) ASC
)
UPDATE public.water_permit_wells w
SET equipment_id = n.equipment_id
FROM nearest n
WHERE w.id = n.well_id
  AND w.equipment_id IS DISTINCT FROM n.equipment_id;

-- ── 4. Vazão do equipamento = m³/dia da outorga ÷ regime (h/dia) ────────────
-- Se um equipamento (improvável aqui) ficar ligado a >1 poço, prevalece a MAIOR
-- vazão/h (mais conservador p/ compliance de outorga).
WITH per_equip AS (
  SELECT DISTINCT ON (w.equipment_id)
         w.equipment_id,
         ROUND(p.flow_rate_m3_day / NULLIF(COALESCE(p.regime_hours_per_day, 18), 0)) AS flow_h
  FROM public.water_permit_wells w
  JOIN public.water_permits p ON p.id = w.permit_id
  WHERE w.equipment_id IS NOT NULL
    AND p.flow_rate_m3_day IS NOT NULL
  ORDER BY w.equipment_id,
           (p.flow_rate_m3_day / NULLIF(COALESCE(p.regime_hours_per_day, 18), 0)) DESC
)
UPDATE public.equipments e
SET estimated_flow_m3h = pe.flow_h
FROM per_equip pe
WHERE e.id = pe.equipment_id
  AND pe.flow_h IS NOT NULL
  AND e.estimated_flow_m3h IS DISTINCT FROM pe.flow_h;

-- ── 5. Relatório no log (não altera nada) ───────────────────────────────────
DO $$
DECLARE
  v_linked int;
  v_flow500 int;
  v_flow300 int;
BEGIN
  SELECT count(*) INTO v_linked FROM public.water_permit_wells WHERE equipment_id IS NOT NULL;
  SELECT count(*) INTO v_flow500 FROM public.equipments WHERE estimated_flow_m3h = 500;
  SELECT count(*) INTO v_flow300 FROM public.equipments WHERE estimated_flow_m3h = 300;
  RAISE NOTICE 'Auto-vínculo por coordenada: % poços vinculados; equipamentos 500 m³/h=%, 300 m³/h=%',
    v_linked, v_flow500, v_flow300;
END $$;
