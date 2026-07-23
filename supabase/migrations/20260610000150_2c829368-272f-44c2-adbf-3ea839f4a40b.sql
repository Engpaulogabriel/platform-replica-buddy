
ALTER TABLE public.farm_productivity_config
  ADD COLUMN IF NOT EXISTS default_flow_m3h numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS manual_useful_hours_per_day numeric NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS manual_travel_minutes_per_trigger numeric NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS manual_restart_delay_minutes numeric NOT NULL DEFAULT 60;
