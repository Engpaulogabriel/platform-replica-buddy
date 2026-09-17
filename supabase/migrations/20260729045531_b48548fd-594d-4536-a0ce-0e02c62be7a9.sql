ALTER TABLE public.inema_permits ALTER COLUMN water_use_purpose SET DEFAULT 'Irrigação';
UPDATE public.inema_permits SET water_use_purpose = 'Irrigação' WHERE water_use_purpose IS NULL;