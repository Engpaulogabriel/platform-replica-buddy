ALTER TABLE public.inema_permits
  ADD COLUMN IF NOT EXISTS process_number text,
  ADD COLUMN IF NOT EXISTS max_flow_m3h numeric,
  ADD COLUMN IF NOT EXISTS water_use_purpose text,
  ADD COLUMN IF NOT EXISTS hydrographic_basin text;