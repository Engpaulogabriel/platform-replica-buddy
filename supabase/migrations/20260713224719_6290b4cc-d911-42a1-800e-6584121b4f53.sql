
-- 1. Habilitar pg_net
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- 2. Função disparada pelo trigger
CREATE OR REPLACE FUNCTION public.notify_equipment_state_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _supabase_url text := 'https://dnyukgfedredvxpzjpqz.supabase.co';
  _anon_key text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRueXVrZ2ZlZHJlZHZ4cHpqcHF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2ODU1OTQsImV4cCI6MjA5MjI2MTU5NH0.OSg44w0CRVvD-f6Ts_U9DVeQkQ-4c37passKEK5X0kk';
  _service_role_key text;
  _auth_key text;
  _payload jsonb;
  _equipment_name text;
  _farm_name text;
  _farm_id uuid;
  _origin text;
BEGIN
  -- Só dispara se o estado confirmado realmente mudou
  IF OLD.last_confirmed_state IS NOT DISTINCT FROM NEW.last_confirmed_state THEN
    RETURN NEW;
  END IF;

  _equipment_name := NEW.name;
  _farm_id := NEW.farm_id;
  _origin := COALESCE(NEW.last_actuation_origin, 'Local');

  SELECT f.name INTO _farm_name
  FROM public.farms f WHERE f.id = _farm_id;

  -- Tentar buscar service_role key do vault; fallback para anon key
  BEGIN
    SELECT decrypted_secret INTO _service_role_key
    FROM vault.decrypted_secrets
    WHERE name = 'service_role_key'
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    _service_role_key := NULL;
  END;

  _auth_key := COALESCE(_service_role_key, _anon_key);

  _payload := jsonb_build_object(
    'type', 'alert',
    'immediate', true,
    'source', 'db_trigger',
    'farm_id', _farm_id,
    'equipment_id', NEW.id,
    'equipment_name', _equipment_name,
    'farm_name', _farm_name,
    'old_state', OLD.last_confirmed_state,
    'new_state', NEW.last_confirmed_state,
    'action', CASE WHEN NEW.last_confirmed_state = 0 THEN 'turn_off' ELSE 'turn_on' END,
    'origin', _origin,
    'message', COALESCE(_equipment_name, 'Equipamento') ||
               CASE WHEN NEW.last_confirmed_state = 0 THEN ' desligou' ELSE ' ligou' END ||
               ' (' || _origin || ')'
  );

  PERFORM net.http_post(
    url := _supabase_url || '/functions/v1/whatsapp-automation-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', _auth_key,
      'Authorization', 'Bearer ' || _auth_key
    ),
    body := _payload
  );

  RETURN NEW;
END;
$$;

-- 3. Trigger na tabela equipments
DROP TRIGGER IF EXISTS trg_notify_equipment_state_change ON public.equipments;
CREATE TRIGGER trg_notify_equipment_state_change
  AFTER UPDATE OF last_confirmed_state ON public.equipments
  FOR EACH ROW
  WHEN (OLD.last_confirmed_state IS DISTINCT FROM NEW.last_confirmed_state)
  EXECUTE FUNCTION public.notify_equipment_state_change();
