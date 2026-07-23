
-- Sino de alertas reativado: estende farm_notifications com kind/equipment_id/resolved_at
-- e adiciona toggle bell_alerts_enabled por fazenda.

ALTER TABLE public.farm_notifications
  ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'failure',
  ADD COLUMN IF NOT EXISTS equipment_id uuid REFERENCES public.equipments(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

ALTER TABLE public.farm_notifications
  DROP CONSTRAINT IF EXISTS farm_notifications_kind_check;
ALTER TABLE public.farm_notifications
  ADD CONSTRAINT farm_notifications_kind_check CHECK (kind IN ('failure','system'));

-- Backfill: marca eventos informativos conhecidos como 'system'
UPDATE public.farm_notifications
SET kind = 'system'
WHERE source IN ('peak_hour_start','peak_hour_end','auto_batch','agent_reconnect','ota_applied','reset_executed');

CREATE INDEX IF NOT EXISTS idx_farm_notifications_farm_kind_created
  ON public.farm_notifications (farm_id, kind, created_at DESC);

ALTER TABLE public.farms
  ADD COLUMN IF NOT EXISTS bell_alerts_enabled boolean NOT NULL DEFAULT false;
