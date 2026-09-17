ALTER TABLE public.farms
  ADD COLUMN IF NOT EXISTS comm_timeout_minutes integer NOT NULL DEFAULT 15;

COMMENT ON COLUMN public.farms.comm_timeout_minutes IS 'Minutos sem comunicação até considerar equipamento offline (alertas críticos).';