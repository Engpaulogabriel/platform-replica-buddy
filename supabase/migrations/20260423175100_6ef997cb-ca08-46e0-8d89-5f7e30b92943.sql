-- Trigger para registrar TODA mudança de estado da bomba em automation_log,
-- independentemente da origem (Local físico ou Remoto via comando).
-- Isso garante que o "Mini Relatório" no Dashboard mostre as últimas leituras
-- reais, pois ele lê de automation_log via Realtime.

CREATE OR REPLACE FUNCTION public.log_equipment_state_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_saida_idx int;
  v_old_running boolean;
  v_new_running boolean;
  v_origin event_origin;
  v_action event_action;
  v_dup_count int;
BEGIN
  -- Apenas para tipos relevantes
  IF NEW.type NOT IN ('poco', 'bombeamento') THEN
    RETURN NEW;
  END IF;

  v_saida_idx := COALESCE(NEW.saida, 1);

  -- Estado anterior
  IF OLD.last_outputs_state ~ '^[01]{6}$' AND v_saida_idx BETWEEN 1 AND 6 THEN
    v_old_running := substring(OLD.last_outputs_state from v_saida_idx for 1) = '1';
  ELSIF OLD.last_outputs_state ~ '^[01]$' THEN
    v_old_running := OLD.last_outputs_state = '1';
  ELSE
    v_old_running := false;
  END IF;

  -- Estado novo
  IF NEW.last_outputs_state ~ '^[01]{6}$' AND v_saida_idx BETWEEN 1 AND 6 THEN
    v_new_running := substring(NEW.last_outputs_state from v_saida_idx for 1) = '1';
  ELSIF NEW.last_outputs_state ~ '^[01]$' THEN
    v_new_running := NEW.last_outputs_state = '1';
  ELSE
    v_new_running := false;
  END IF;

  -- Sem mudança real: nada a registrar
  IF v_old_running IS NOT DISTINCT FROM v_new_running THEN
    RETURN NEW;
  END IF;

  -- Determina origem com base no last_actuation_origin
  v_origin := CASE
    WHEN NEW.last_actuation_origin = 'local' THEN 'local'::event_origin
    WHEN NEW.last_actuation_origin = 'remote' THEN 'remote'::event_origin
    ELSE 'reading'::event_origin
  END;

  v_action := CASE WHEN v_new_running THEN 'turn_on'::event_action ELSE 'turn_off'::event_action END;

  -- Anti-duplicidade: não loga se já houve evento idêntico nos últimos 5s
  -- (evita ruído quando o mesmo update cai duas vezes)
  SELECT count(*) INTO v_dup_count
  FROM public.automation_log
  WHERE equipment_id = NEW.id
    AND action = v_action
    AND occurred_at > now() - interval '5 seconds';

  IF v_dup_count > 0 THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.automation_log (
    farm_id, equipment_id, equipment_name,
    occurred_at, origin, action, result,
    new_state, client_event_id, source_device, details
  )
  VALUES (
    NEW.farm_id, NEW.id, NEW.name,
    COALESCE(NEW.last_communication, now()),
    v_origin, v_action, 'success'::event_result,
    NEW.last_outputs_state,
    gen_random_uuid(),
    'auto-trigger',
    jsonb_build_object('actuation_origin', NEW.last_actuation_origin)
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_equipments_log_state_change ON public.equipments;

CREATE TRIGGER trg_equipments_log_state_change
AFTER UPDATE OF last_outputs_state ON public.equipments
FOR EACH ROW
WHEN (OLD.last_outputs_state IS DISTINCT FROM NEW.last_outputs_state)
EXECUTE FUNCTION public.log_equipment_state_change();