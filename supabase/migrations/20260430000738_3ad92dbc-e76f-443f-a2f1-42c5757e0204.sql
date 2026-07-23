-- Fecha eventuais sessões duplicadas em aberto (mantém a mais recente)
WITH ranked AS (
  SELECT id, equipment_id,
         row_number() OVER (PARTITION BY equipment_id ORDER BY started_at DESC) AS rn
  FROM public.pump_runtime
  WHERE ended_at IS NULL
)
UPDATE public.pump_runtime pr
SET ended_at = now(),
    duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (now() - pr.started_at))::int)
FROM ranked
WHERE pr.id = ranked.id AND ranked.rn > 1;

-- Cria a unique parcial que a trigger track_pump_runtime referencia em ON CONFLICT
CREATE UNIQUE INDEX IF NOT EXISTS pump_runtime_one_open_per_equipment
  ON public.pump_runtime (equipment_id)
  WHERE ended_at IS NULL;