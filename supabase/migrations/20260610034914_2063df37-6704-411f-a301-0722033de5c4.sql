
ALTER TABLE public.agent_config
  ADD COLUMN IF NOT EXISTS tx_gap_ms INTEGER NOT NULL DEFAULT 100;

INSERT INTO public.agent_config (farm_id, serial_port)
SELECT f.id, 'COM1'
FROM public.farms f
LEFT JOIN public.agent_config c ON c.farm_id = f.id
WHERE c.farm_id IS NULL;
