
-- Trigger: cascatear mudança de hw_id do PLC para equipments.hw_id
CREATE OR REPLACE FUNCTION public.cancel_pending_on_plc_group_hw_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_new_tsnn text;
BEGIN
  IF NEW.hw_id IS DISTINCT FROM OLD.hw_id THEN
    v_new_tsnn := upper(coalesce(NEW.hw_id, ''));

    UPDATE public.commands c
    SET status = 'cancelled',
        error_message = 'hw_id do PLC foi alterado — comando obsoleto'
    WHERE c.status IN ('pending', 'sent')
      AND c.equipment_id IN (SELECT id FROM public.equipments WHERE plc_group_id = NEW.id);

    IF v_new_tsnn <> '' AND length(v_new_tsnn) = 4 THEN
      -- Bypass do trigger equipments_writer_telemetry_only nesta cascata
      PERFORM set_config('session_replication_role', 'replica', true);
      UPDATE public.equipments
      SET hw_id = v_new_tsnn || substring(hw_id from 5),
          last_polling_at = NULL
      WHERE plc_group_id = NEW.id
        AND length(coalesce(hw_id, '')) >= 4
        AND upper(substring(hw_id from 1 for 4)) <> v_new_tsnn;
      PERFORM set_config('session_replication_role', 'origin', true);
    ELSE
      UPDATE public.equipments SET last_polling_at = NULL WHERE plc_group_id = NEW.id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Reparo dos dados existentes (contorna trigger de operador)
SET LOCAL session_replication_role = replica;
UPDATE public.equipments e
SET hw_id = upper(g.hw_id) || substring(e.hw_id from 5),
    last_polling_at = NULL
FROM public.plc_groups g
WHERE e.plc_group_id = g.id
  AND length(coalesce(g.hw_id,'')) = 4
  AND length(coalesce(e.hw_id,'')) >= 4
  AND upper(substring(e.hw_id from 1 for 4)) <> upper(g.hw_id);
SET LOCAL session_replication_role = origin;
