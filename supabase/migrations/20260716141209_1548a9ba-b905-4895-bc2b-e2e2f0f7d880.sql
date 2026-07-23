UPDATE public.platform_settings
SET value = jsonb_build_object(
  'enabled', false,
  'farm_ids', jsonb_build_array('1014a8ab-b02a-47c7-90fc-1646d52a991e'),
  'user_ids', jsonb_build_array('72a12304-4de5-4b46-bd42-7b6c9c942cc9')
),
updated_at = now()
WHERE key = 'device_auth';

INSERT INTO public.platform_settings (key, value, updated_at)
SELECT 'device_auth', jsonb_build_object(
  'enabled', false,
  'farm_ids', jsonb_build_array('1014a8ab-b02a-47c7-90fc-1646d52a991e'),
  'user_ids', jsonb_build_array('72a12304-4de5-4b46-bd42-7b6c9c942cc9')
), now()
WHERE NOT EXISTS (
  SELECT 1 FROM public.platform_settings WHERE key = 'device_auth'
);

UPDATE public.farms
SET device_limit = 1
WHERE id = '1014a8ab-b02a-47c7-90fc-1646d52a991e';