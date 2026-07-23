-- Correção emergencial: garantir índice único parcial em pump_runtime
CREATE TABLE IF NOT EXISTS public.pump_runtime (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id uuid NOT NULL REFERENCES public.equipments(id) ON DELETE CASCADE,
  farm_id uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

ALTER TABLE public.pump_runtime ENABLE ROW LEVEL SECURITY;

DROP INDEX IF EXISTS public.pump_runtime_one_open_per_equipment;

DELETE FROM public.pump_runtime a
USING public.pump_runtime b
WHERE a.equipment_id = b.equipment_id
  AND a.ended_at IS NULL
  AND b.ended_at IS NULL
  AND a.started_at < b.started_at;

CREATE UNIQUE INDEX pump_runtime_one_open_per_equipment
ON public.pump_runtime (equipment_id)
WHERE ended_at IS NULL;