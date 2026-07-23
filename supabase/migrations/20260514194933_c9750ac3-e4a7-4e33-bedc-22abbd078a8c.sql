ALTER TABLE public.farm_productivity_config
  ADD COLUMN IF NOT EXISTS manual_operation_time_minutes integer NOT NULL DEFAULT 80,
  ADD COLUMN IF NOT EXISTS remote_operation_time_minutes integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS cycles_per_day integer NOT NULL DEFAULT 2;