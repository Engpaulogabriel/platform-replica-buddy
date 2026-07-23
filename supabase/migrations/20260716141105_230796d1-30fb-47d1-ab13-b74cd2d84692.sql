UPDATE public.platform_settings
SET value = jsonb_build_object('enabled', true), updated_at = now()
WHERE key = 'device_auth';

INSERT INTO public.platform_settings (key, value, updated_at)
SELECT 'device_auth', jsonb_build_object('enabled', true), now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.platform_settings WHERE key = 'device_auth'
);

UPDATE public.farms
SET device_limit = 1
WHERE id = '1014a8ab-b02a-47c7-90fc-1646d52a991e';

UPDATE public.device_register_links
SET consumed_at = COALESCE(consumed_at, now())
WHERE target_user_id = '72a12304-4de5-4b46-bd42-7b6c9c942cc9'
  AND consumed_at IS NULL;

UPDATE public.device_access_attempts
SET status = 'ignored', reviewed_at = now()
WHERE user_id = '72a12304-4de5-4b46-bd42-7b6c9c942cc9'
  AND status = 'blocked';