ALTER TABLE public.device_licenses ADD COLUMN IF NOT EXISTS fingerprint_mismatch_count integer DEFAULT 0;
ALTER TABLE public.device_licenses ADD COLUMN IF NOT EXISTS last_fingerprint_check timestamptz;

UPDATE public.agent_releases SET is_latest = false WHERE is_latest = true;
UPDATE public.agent_releases SET is_latest = true WHERE version = '3.25.45';