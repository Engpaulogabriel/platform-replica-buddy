
ALTER TABLE public.whatsapp_alert_settings
  ADD COLUMN IF NOT EXISTS peak_hour_weekdays integer[] NOT NULL DEFAULT '{1,2,3,4,5}';
