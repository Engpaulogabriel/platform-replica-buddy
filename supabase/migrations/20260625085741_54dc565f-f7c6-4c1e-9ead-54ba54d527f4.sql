
ALTER TABLE public.whatsapp_groups
  ADD COLUMN IF NOT EXISTS alert_channel text NOT NULL DEFAULT 'group'
  CHECK (alert_channel IN ('group','private','both'));

ALTER TABLE public.whatsapp_operators
  ADD COLUMN IF NOT EXISTS notification_preference text NOT NULL DEFAULT 'default'
  CHECK (notification_preference IN ('default','private','group','mute'));
