-- Backfill: abre sessão de runtime para bombas que estão atualmente ligadas
-- mas que não têm sessão aberta (porque o trigger foi religado depois delas
-- já estarem ligadas e só registra TRANSIÇÕES).
INSERT INTO public.pump_runtime (farm_id, equipment_id, started_at)
SELECT
  e.farm_id,
  e.id,
  COALESCE(e.runtime_checkpoint_at, e.last_communication, now())
FROM public.equipments e
WHERE e.type IN ('poco','bombeamento')
  AND e.active = true
  AND e.last_outputs_state IS NOT NULL
  AND (
    (e.last_outputs_state ~ '^[01]{6}$'
       AND COALESCE(e.saida,1) BETWEEN 1 AND 6
       AND substring(e.last_outputs_state from COALESCE(e.saida,1) for 1) = '1')
    OR (e.last_outputs_state ~ '^[01]$' AND e.last_outputs_state = '1')
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.pump_runtime r
    WHERE r.equipment_id = e.id AND r.ended_at IS NULL
  );

-- Atualiza checkpoint para os que ficaram sem (Poço 09, etc.) para que
-- close_orphan_pump_runtime tenha referência.
UPDATE public.equipments
SET runtime_checkpoint_at = COALESCE(runtime_checkpoint_at, last_communication, now())
WHERE type IN ('poco','bombeamento')
  AND last_outputs_state ~ '1'
  AND runtime_checkpoint_at IS NULL;