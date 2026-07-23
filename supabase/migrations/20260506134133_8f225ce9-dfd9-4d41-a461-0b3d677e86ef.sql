CREATE TABLE IF NOT EXISTS public.farm_maintenance_locks (
  farm_id uuid PRIMARY KEY,
  activated_at timestamptz NOT NULL DEFAULT now(),
  activated_by uuid,
  expires_at timestamptz NOT NULL,
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.farm_maintenance_locks ENABLE ROW LEVEL SECURITY;

CREATE POLICY fml_select_members ON public.farm_maintenance_locks
  FOR SELECT TO authenticated
  USING (has_farm_access(auth.uid(), farm_id) OR is_platform_staff(auth.uid()));

CREATE OR REPLACE FUNCTION public.platform_maintenance_activate(
  _farm_id uuid,
  _minutes int DEFAULT 30,
  _reason text DEFAULT NULL
) RETURNS public.farm_maintenance_locks
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE v_row public.farm_maintenance_locks;
BEGIN
  IF NOT is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Apenas platform_admin pode ativar Modo Manutenção';
  END IF;
  IF _minutes IS NULL OR _minutes < 5 OR _minutes > 240 THEN
    _minutes := 30;
  END IF;

  INSERT INTO public.farm_maintenance_locks(farm_id, activated_by, expires_at, reason)
  VALUES (_farm_id, auth.uid(), now() + make_interval(mins => _minutes), _reason)
  ON CONFLICT (farm_id) DO UPDATE
    SET activated_at = now(),
        activated_by = EXCLUDED.activated_by,
        expires_at = EXCLUDED.expires_at,
        reason = EXCLUDED.reason,
        updated_at = now()
  RETURNING * INTO v_row;

  UPDATE public.commands SET status = 'cancelled', error_message = 'maintenance-mode-activated', responded_at = now()
  WHERE farm_id = _farm_id AND status = 'pending';

  RETURN v_row;
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_maintenance_release(_farm_id uuid)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF NOT is_platform_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Apenas platform_admin pode encerrar Modo Manutenção';
  END IF;
  DELETE FROM public.farm_maintenance_locks WHERE farm_id = _farm_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_farm_in_maintenance(_farm_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.farm_maintenance_locks
    WHERE farm_id = _farm_id AND expires_at > now()
  );
$$;

GRANT EXECUTE ON FUNCTION public.platform_maintenance_activate(uuid, int, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.platform_maintenance_release(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_farm_in_maintenance(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.commands_block_during_maintenance()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.type IN ('on','off','reset') AND public.is_farm_in_maintenance(NEW.farm_id) THEN
    RAISE EXCEPTION 'Fazenda em Modo Manutenção. Comandos bloqueados.';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS commands_block_maintenance_trg ON public.commands;
CREATE TRIGGER commands_block_maintenance_trg
  BEFORE INSERT ON public.commands
  FOR EACH ROW EXECUTE FUNCTION public.commands_block_during_maintenance();

CREATE OR REPLACE FUNCTION public.enqueue_polling_for_due_equipments_internal(_farm_id uuid)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_plc RECORD;
  v_eq RECORD;
  v_payload text;
  v_pos int;
  v_max_saida int;
  v_plc_total int;
  v_frame text;
  v_first_eq_id uuid;
BEGIN
  IF public.is_farm_in_maintenance(_farm_id) THEN RETURN 0; END IF;

  DELETE FROM public.commands
  WHERE farm_id = _farm_id AND status = 'pending' AND type = 'polling'
    AND created_at < now() - interval '30 seconds';

  UPDATE public.commands
  SET status = 'timeout', responded_at = now(),
      error_message = 'Sem resposta dentro do timeout'
  WHERE farm_id = _farm_id AND status = 'sent' AND type = 'polling'
    AND sent_at < now() - (GREATEST(timeout_ms, 13000) || ' milliseconds')::interval;

  IF EXISTS (
    SELECT 1 FROM public.commands c
    WHERE c.farm_id = _farm_id AND c.type = 'polling'
      AND c.source_device = 'platform-scheduler'
      AND c.created_at > now() - interval '12.5 seconds'
  ) THEN RETURN 0; END IF;

  IF EXISTS (
    SELECT 1 FROM public.commands c
    WHERE c.farm_id = _farm_id AND c.status IN ('pending', 'sent') AND c.type = 'polling'
  ) THEN RETURN 0; END IF;

  SELECT
    COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) AS tsnn,
    MIN(e.last_polling_at) AS oldest_polling_at,
    MAX(COALESCE(pg.output_count, 1)) AS plc_total
  INTO v_plc
  FROM public.equipments e
  LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
  WHERE e.farm_id = _farm_id AND e.active = true
    AND e.type IN ('poco', 'bombeamento', 'nivel')
    AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) IS NOT NULL
    AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) ~ '^\d{4}$'
    AND NOT EXISTS (
      SELECT 1 FROM public.service_mode_locks sml
      WHERE sml.farm_id = _farm_id
        AND sml.tsnn = COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4))
        AND sml.expires_at > now()
    )
  GROUP BY 1
  ORDER BY oldest_polling_at ASC NULLS FIRST, tsnn ASC
  LIMIT 1;

  IF v_plc.tsnn IS NULL THEN RETURN 0; END IF;

  SELECT COALESCE(MAX(COALESCE(e.saida, 1)), 0)
  INTO v_max_saida
  FROM public.equipments e
  LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
  WHERE e.farm_id = _farm_id AND e.active = true
    AND e.type IN ('poco', 'bombeamento')
    AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) = v_plc.tsnn;

  v_plc_total := GREATEST(v_max_saida, COALESCE(v_plc.plc_total, 1));
  IF v_plc_total < 1 THEN v_plc_total := 1; END IF;
  IF v_plc_total > 6 THEN v_plc_total := 6; END IF;

  v_payload := repeat('0', v_plc_total);

  FOR v_eq IN
    SELECT e.id, e.saida, e.desired_running, e.type
    FROM public.equipments e
    LEFT JOIN public.plc_groups pg ON pg.id = e.plc_group_id
    WHERE e.farm_id = _farm_id AND e.active = true
      AND e.type IN ('poco', 'bombeamento')
      AND COALESCE(NULLIF(pg.hw_id, ''), substring(e.hw_id from 1 for 4)) = v_plc.tsnn
  LOOP
    v_pos := COALESCE(v_eq.saida, 1);
    IF v_pos < 1 OR v_pos > v_plc_total THEN CONTINUE; END IF;
    IF v_eq.desired_running THEN
      v_payload := overlay(v_payload placing '1' from v_pos for 1);
    END IF;
  END LOOP;

  v_frame := '[' || v_plc.tsnn || '_1_]{' || v_payload || '}[' || v_plc.tsnn || '_ETX_]' || E'\r';

  SELECT id INTO v_first_eq_id
  FROM public.equipments
  WHERE farm_id = _farm_id AND active = true
    AND COALESCE(substring(hw_id from 1 for 4), '') = v_plc.tsnn
  ORDER BY saida NULLS LAST, created_at ASC
  LIMIT 1;

  INSERT INTO public.commands(farm_id, equipment_id, plc_hw_id, type, status, frame,
                              priority, timeout_ms, source_device)
  VALUES (_farm_id, v_first_eq_id, v_plc.tsnn, 'polling', 'pending', v_frame,
          5, 13000, 'platform-scheduler');

  UPDATE public.equipments
  SET last_polling_at = now()
  WHERE farm_id = _farm_id AND active = true
    AND COALESCE(substring(hw_id from 1 for 4), '') = v_plc.tsnn;

  RETURN 1;
END;
$function$;