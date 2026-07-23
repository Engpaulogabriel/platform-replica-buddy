
ALTER TABLE public.whatsapp_maintenance_pending
  ADD COLUMN IF NOT EXISTS equipment_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  ADD COLUMN IF NOT EXISTS equipment_names text[] NOT NULL DEFAULT '{}'::text[],
  ADD COLUMN IF NOT EXISTS awaiting_numbers boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS base_label text;

ALTER TABLE public.whatsapp_maintenance_pending
  ALTER COLUMN equipment_id DROP NOT NULL,
  ALTER COLUMN equipment_name DROP NOT NULL;
