CREATE TYPE public.agent_cmd_kind AS ENUM (
  'close_port',
  'open_port',
  'change_port',
  'hard_reset_bridge',
  'set_log_level',
  'send_manual_frame',
  'pause_polling',
  'resume_polling',
  'list_ports'
);

CREATE TYPE public.agent_cmd_status AS ENUM (
  'pending',
  'ack',
  'executing',
  'done',
  'error',
  'expired'
);

CREATE TABLE public.agent_commands (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farm_id       uuid NOT NULL REFERENCES public.farms(id) ON DELETE CASCADE,
  kind          public.agent_cmd_kind NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  status        public.agent_cmd_status NOT NULL DEFAULT 'pending',
  result        jsonb,
  error_message text,
  created_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  ack_at        timestamptz,
  executed_at   timestamptz,
  duration_ms   integer,
  expires_at    timestamptz NOT NULL DEFAULT (now() + interval '5 minutes')
);

CREATE INDEX agent_commands_farm_status_idx
  ON public.agent_commands (farm_id, status, created_at DESC);

ALTER TABLE public.agent_commands ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_commands_select_members"
  ON public.agent_commands FOR SELECT
  TO authenticated
  USING (public.has_farm_access(auth.uid(), farm_id));

CREATE POLICY "agent_commands_insert_writers"
  ON public.agent_commands FOR INSERT
  TO authenticated
  WITH CHECK (
    public.can_write_farm(auth.uid(), farm_id)
    AND (created_by IS NULL OR created_by = auth.uid())
  );

CREATE POLICY "agent_commands_update_writers"
  ON public.agent_commands FOR UPDATE
  TO authenticated
  USING (public.can_write_farm(auth.uid(), farm_id))
  WITH CHECK (public.can_write_farm(auth.uid(), farm_id));

ALTER PUBLICATION supabase_realtime ADD TABLE public.agent_commands;
ALTER TABLE public.agent_commands REPLICA IDENTITY FULL;

CREATE OR REPLACE FUNCTION public.mark_agent_commands_expired(_farm_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF NOT public.can_write_farm(auth.uid(), _farm_id) THEN
    RAISE EXCEPTION 'Sem permissao para fazenda %', _farm_id;
  END IF;

  WITH updated AS (
    UPDATE public.agent_commands
    SET status = 'expired',
        error_message = 'Comando expirou sem resposta do agent'
    WHERE farm_id = _farm_id
      AND status IN ('pending', 'ack', 'executing')
      AND expires_at < now()
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM updated;

  RETURN COALESCE(v_count, 0);
END;
$$;