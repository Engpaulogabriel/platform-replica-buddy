-- Notificações compartilhadas por fazenda (todos os usuários da fazenda veem)
CREATE TABLE public.farm_notifications (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  farm_id UUID NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  source TEXT,
  source_ref UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_farm_notifications_farm_created
  ON public.farm_notifications(farm_id, created_at DESC);

-- Evita duplicar a mesma notificação de mesma origem (ex: mesma falha do automation_log)
CREATE UNIQUE INDEX idx_farm_notifications_source_unique
  ON public.farm_notifications(farm_id, source, source_ref)
  WHERE source IS NOT NULL AND source_ref IS NOT NULL;

ALTER TABLE public.farm_notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "farm_notifications_select_members"
  ON public.farm_notifications FOR SELECT TO authenticated
  USING (has_farm_access(auth.uid(), farm_id));

CREATE POLICY "farm_notifications_select_platform_staff"
  ON public.farm_notifications FOR SELECT TO authenticated
  USING (is_platform_staff(auth.uid()));

CREATE POLICY "farm_notifications_insert_writers"
  ON public.farm_notifications FOR INSERT TO authenticated
  WITH CHECK (can_write_farm(auth.uid(), farm_id));

-- Marca de "lido" por usuário (alerta compartilhado, leitura individual)
CREATE TABLE public.farm_notification_reads (
  notification_id UUID NOT NULL REFERENCES public.farm_notifications(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  read_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);

CREATE INDEX idx_farm_notification_reads_user
  ON public.farm_notification_reads(user_id, notification_id);

ALTER TABLE public.farm_notification_reads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "farm_notification_reads_own_select"
  ON public.farm_notification_reads FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "farm_notification_reads_own_insert"
  ON public.farm_notification_reads FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "farm_notification_reads_own_delete"
  ON public.farm_notification_reads FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE public.farm_notifications;
ALTER PUBLICATION supabase_realtime ADD TABLE public.farm_notification_reads;