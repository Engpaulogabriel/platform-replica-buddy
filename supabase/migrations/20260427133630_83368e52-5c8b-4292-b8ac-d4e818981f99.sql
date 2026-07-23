-- 1) Migrar programações 'both' em duas: on-only + off-only
INSERT INTO public.automation_schedules (
  farm_id, equipment_id, active, mode, days, time_on, time_off, created_by
)
SELECT
  farm_id, equipment_id, active, 'off-only', days, time_on, time_off, created_by
FROM public.automation_schedules
WHERE mode = 'both';

-- Converte as 'both' originais em 'on-only' (mantém time_off por compatibilidade, motor ignora)
UPDATE public.automation_schedules
SET mode = 'on-only'
WHERE mode = 'both';

-- 2) Default novo passa a ser 'on-only'
ALTER TABLE public.automation_schedules
  ALTER COLUMN mode SET DEFAULT 'on-only';

-- 3) Constraint impedindo 'both' a partir de agora
ALTER TABLE public.automation_schedules
  DROP CONSTRAINT IF EXISTS automation_schedules_mode_check;

ALTER TABLE public.automation_schedules
  ADD CONSTRAINT automation_schedules_mode_check
  CHECK (mode IN ('on-only', 'off-only'));