-- ============================================================================
-- VÍNCULO AUTOMÁTICO DE POÇOS POR COORDENADA (só o vínculo — NÃO altera vazão)
-- ----------------------------------------------------------------------------
-- Objetivo (pedido do usuário):
--   1. Converter as coordenadas DMS (texto) de water_permit_wells → decimal.
--   2. Comparar com latitude/longitude (decimais) dos equipamentos da MESMA
--      fazenda (equipments.type='poco', ativos).
--   3. Vincular cada poço da outorga (water_permit_wells.equipment_id) ao
--      equipamento mais PRÓXIMO da mesma fazenda, SEM limite de distância — o
--      GPS de campo da portaria pode divergir do GPS do sistema, mas é o mesmo
--      poço; então o mais próximo é sempre o correto.
--
-- ⚠️ NÃO altera equipments.estimated_flow_m3h. Distinção importante:
--   • estimated_flow_m3h = vazão OPERACIONAL da bomba instalada (300 m³/h em
--     TODOS os poços). É o que entra no cálculo de VOLUME CAPTADO.
--   • Vazão AUTORIZADA (ex.: 500 m³/h = 9000/18 nas portarias 25.560/27.368) NÃO
--     é gravada em equipments — vem da outorga vinculada
--     (water_permit_wells.flow_rate_m3_day) e aparece SÓ no Compliance como LIMITE.
--   Por isso esta migration não toca em estimated_flow_m3h (permanece 300).
--
-- Idempotente. Genérico (roda p/ qualquer fazenda com water_permits). Vincula
-- CADA poço ao equipamento mais próximo (sobrescreve vínculo anterior). Aplicar
-- via push (Lovable) ou SQL Editor.
--
-- Resultado validado offline (Semear, 2026-08-11) contra os equipamentos ao vivo:
--   BIJEÇÃO PERFEITA: os 16 poços da Semear casam 1:1 com os 16 equipamentos,
--   ZERO colisões (cada equipamento recebe exatamente 1 poço). POÇO 10 R4 ←
--   Poço 10 (33.285, ~394 m) e POÇO 16 R4 ← Poço 16 (33.285, ~902 m) também
--   vinculados (imprecisão de GPS de campo — é o mesmo poço). Agronave (28.608)
--   tem farm_id próprio/NULL → não casa com a Semear. OK.
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

-- ── 4. Relatório no log (não altera nada) ───────────────────────────────────
-- NÃO existe UPDATE de estimated_flow_m3h aqui — de propósito. A vazão
-- operacional (300) das bombas não é derivada da outorga; a vazão autorizada
-- (500) sai da outorga só no Compliance. Ver cabeçalho.
DO $$
DECLARE
  v_linked int;
BEGIN
  SELECT count(*) INTO v_linked FROM public.water_permit_wells WHERE equipment_id IS NOT NULL;
  RAISE NOTICE 'Auto-vínculo por coordenada: % poços vinculados (estimated_flow_m3h inalterado — 300 operacional).', v_linked;
END $$;
