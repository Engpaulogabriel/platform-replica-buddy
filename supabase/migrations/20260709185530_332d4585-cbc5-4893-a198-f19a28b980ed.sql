
ALTER TABLE public.pending_notifications
  ADD COLUMN IF NOT EXISTS retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS retry_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error text;

CREATE INDEX IF NOT EXISTS pending_notifications_ready_idx
  ON public.pending_notifications (retry_at)
  WHERE processed = false;
