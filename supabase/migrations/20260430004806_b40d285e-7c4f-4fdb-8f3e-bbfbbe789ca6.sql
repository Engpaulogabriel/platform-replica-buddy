-- Remove qualquer trigger remanescente que use track_pump_runtime
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT t.tgname, c.relname
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE n.nspname='public' AND NOT t.tgisinternal AND p.proname='track_pump_runtime'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', r.tgname, r.relname);
  END LOOP;
END $$;

-- Reescreve a função sem ON CONFLICT (usa IF NOT EXISTS)
CREATE OR REPLACE FUNCTION public.track_pump_runtime()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_saida_idx int;
  v_old_running boolean;
  v_new_running boolean;
  v_open_id uuid;
  v_open_started timestamptz;
BEGIN
  IF NEW.type NOT IN ('poco', 'bombeamento') THEN
    RETURN NEW;
  END IF;

  v_saida_idx := COALESCE(NEW.saida, 1);

  IF OLD.last_outputs_state ~ '^[01]{6}$' AND v_saida_idx BETWEEN 1 AND 6 THEN
    v_old_running := substring(OLD.last_outputs_state from v_saida_idx for 1) = '1';
  ELSIF OLD.last_outputs_state ~ '^[01]$' THEN
    v_old_running := OLD.last_outputs_state = '1';
  ELSE
    v_old_running := false;
  END IF;

  IF NEW.last_outputs_state ~ '^[01]{6}$' AND v_saida_idx BETWEEN 1 AND 6 THEN
    v_new_running := substring(NEW.last_outputs_state from v_saida_idx for 1) = '1';
  ELSIF NEW.last_outputs_state ~ '^[01]$' THEN
    v_new_running := NEW.last_outputs_state = '1';
  ELSE
    v_new_running := false;
  END IF;

  IF v_old_running IS NOT DISTINCT FROM v_new_running THEN
    RETURN NEW;
  END IF;

  IF v_new_running THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.pump_runtime
      WHERE equipment_id = NEW.id AND ended_at IS NULL
    ) THEN
      INSERT INTO public.pump_runtime (farm_id, equipment_id, started_at)
      VALUES (NEW.farm_id, NEW.id, COALESCE(NEW.last_communication, now()));
    END IF;
  ELSE
    SELECT id, started_at INTO v_open_id, v_open_started
    FROM public.pump_runtime
    WHERE equipment_id = NEW.id AND ended_at IS NULL
    ORDER BY started_at DESC
    LIMIT 1;

    IF v_open_id IS NOT NULL THEN
      UPDATE public.pump_runtime
      SET ended_at = COALESCE(NEW.last_communication, now()),
          duration_seconds = GREATEST(
            0,
            EXTRACT(EPOCH FROM (COALESCE(NEW.last_communication, now()) - v_open_started))::int
          )
      WHERE id = v_open_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;