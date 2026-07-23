ALTER TABLE public.master_manager_permissions
ADD COLUMN IF NOT EXISTS can_view_indicators boolean NOT NULL DEFAULT false;