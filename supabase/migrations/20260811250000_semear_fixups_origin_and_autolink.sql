-- Semear — 2 correções pontuais.
-- ITEM 1: as bombas desligadas hoje (11/08) às 17h ficaram com
-- last_actuation_origin='local' (cache defasado, corrigido no agente v3.25.63).
-- Como ainda estão desligadas (desired_running=false) e têm log 'off' às 17h de
-- hoje, reatribui para 'remote-desired' (some o badge LOCAL do dashboard).
UPDATE public.equipments e
   SET last_actuation_origin = 'remote-desired'
 WHERE e.farm_id = (SELECT id FROM public.farms WHERE name ILIKE '%semear%' LIMIT 1)
   AND e.last_actuation_origin = 'local'
   AND e.desired_running = false
   AND EXISTS (
     SELECT 1 FROM public.automation_log l
     WHERE l.equipment_id = e.id
       AND l.created_at::date = DATE '2026-08-11'
       AND l.action IN ('pump_off'::public.event_action, 'turn_off'::public.event_action)
       AND EXTRACT(HOUR FROM l.created_at AT TIME ZONE 'America/Bahia') = 17
   );

-- ITEM 4: vinculação AUTOMÁTICA poço↔equipamento por NÚMERO do poço.
-- well_name "Poço 7" → 7 ; equipamento "POÇO 07 R1" → 7. Se houver EXATAMENTE 1
-- equipamento com esse número → vincula; se 0 ou >1 → deixa para vínculo manual.
WITH wm AS (
  SELECT w.id AS well_id,
         substring(w.well_name from '(?i)po[çc]o\s*0*([0-9]+)') AS well_num,
         (SELECT array_agg(e.id) FROM public.equipments e
            WHERE e.farm_id = p.farm_id AND e.type = 'poco' AND e.active = true
              AND substring(e.name from '(?i)po[çc]o\s*0*([0-9]+)')
                = substring(w.well_name from '(?i)po[çc]o\s*0*([0-9]+)')
         ) AS eq_ids
  FROM public.water_permit_wells w
  JOIN public.water_permits p ON p.id = w.permit_id
  JOIN public.farms f ON f.id = p.farm_id
  WHERE f.name ILIKE '%semear%' AND w.equipment_id IS NULL
)
UPDATE public.water_permit_wells w
   SET equipment_id = (wm.eq_ids)[1]
  FROM wm
 WHERE w.id = wm.well_id
   AND wm.well_num IS NOT NULL
   AND wm.eq_ids IS NOT NULL
   AND array_length(wm.eq_ids, 1) = 1;   -- só quando há 1 match único
