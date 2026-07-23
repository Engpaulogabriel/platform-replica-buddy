
CREATE TABLE public.whatsapp_notification_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id uuid NOT NULL,
  operator_key text NOT NULL,
  operator_name text NOT NULL,
  via text NOT NULL,
  action text NOT NULL CHECK (action IN ('on','off')),
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  exclude_phone text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','sent','failed')),
  opened_at timestamptz NOT NULL DEFAULT now(),
  last_added_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.whatsapp_notification_batches TO service_role;

ALTER TABLE public.whatsapp_notification_batches ENABLE ROW LEVEL SECURITY;

-- Sem policies: acesso apenas via service_role (edge functions).

CREATE INDEX idx_wa_batches_status_last ON public.whatsapp_notification_batches(status, last_added_at);
CREATE INDEX idx_wa_batches_lookup ON public.whatsapp_notification_batches(farm_id, operator_key, action, status);

CREATE TRIGGER trg_wa_batches_updated_at
BEFORE UPDATE ON public.whatsapp_notification_batches
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
