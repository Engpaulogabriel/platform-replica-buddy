UPDATE public.automation_log
SET result = 'success'
WHERE farm_id IN (SELECT id FROM public.farms WHERE name ILIKE '%semear%')
  AND origin = 'remote'
  AND result = 'fail'
  AND occurred_at >= '2026-08-11T00:00:00Z';
