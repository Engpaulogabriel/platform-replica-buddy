CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION public.notify_equipment_state_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  _supabase_url text := 'https://dnyukgfedredvxpzjpqz.supabase.co';
  _auth_key text;
  _payload jsonb;
  _equipment_name text;
  _farm_name text;
  _farm_id uuid;
  _has_recent_command boolean;
  _real_origin text;
  _action_text text;
  _should_alert boolean := false;
  _message text;
BEGIN
  IF OLD.last_confirmed_state IS NOT DISTINCT FROM NEW.last_confirmed_state THEN
    RETURN NEW;
  END IF;

  _equipment_name := NEW.name;
  _farm_id := NEW.farm_id;

  SELECT f.name INTO _farm_name FROM farms f WHERE f.id = _farm_id;

  SELECT EXISTS(
    SELECT 1 FROM commands
    WHERE equipment_id = NEW.id
      AND created_at > NOW() - INTERVAL '60 seconds'
      AND type IN ('manual', 'automation')
      AND status IN ('sent', 'executed')
  ) INTO _has_recent_command;

  IF _has_recent_command THEN
    _real_origin := 'remote';
  ELSE
    _real_origin := 'local';
  END IF;

  IF NEW.last_confirmed_state = 1 THEN
    _action_text := 'ligou';
  ELSE
    _action_text := 'desligou';
  END IF;

  IF _real_origin = 'local' THEN
    _should_alert := true;
    _message := '⚠️ ' || _equipment_name || ' ' || _action_text || ' Local (Sem ter dado o comando)';
  ELSIF NEW.last_actuation_origin = 'automation' THEN
    _should_alert := true;
    _message := '🤖 ' || _equipment_name || ' ' || _action_text || ' por horário programado (Automático)';
  ELSE
    _should_alert := false;
  END IF;

  IF NOT _should_alert THEN
    RETURN NEW;
  END IF;

  _auth_key := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRueXVrZ2ZlZHJlZHZ4cHpqcHF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2ODU1OTQsImV4cCI6MjA5MjI2MTU5NH0.OSg44w0CRVvD-f6Ts_U9DVeQkQ-4c37passKEK5X0kk';

  _payload := jsonb_build_object(
    'type', 'alert',
    'immediate', true,
    'source', 'db_trigger',
    'farm_id', _farm_id,
    'equipment_id', NEW.id,
    'equipment_name', _equipment_name,
    'farm_name', COALESCE(_farm_name, 'Fazenda'),
    'old_state', OLD.last_confirmed_state,
    'new_state', NEW.last_confirmed_state,
    'action', CASE WHEN NEW.last_confirmed_state = 0 THEN 'turn_off' ELSE 'turn_on' END,
    'origin', _real_origin,
    'message', _message
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

DROP TRIGGER IF EXISTS trg_notify_equipment_state_change ON equipments;
CREATE TRIGGER trg_notify_equipment_state_change
  AFTER UPDATE OF last_confirmed_state ON equipments
  FOR EACH ROW
  WHEN (OLD.last_confirmed_state IS DISTINCT FROM NEW.last_confirmed_state)
  EXECUTE FUNCTION public.notify_equipment_state_change();

CREATE OR REPLACE FUNCTION public.check_unresponsive_commands()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
  _cmd RECORD;
  _supabase_url text := 'https://dnyukgfedredvxpzjpqz.supabase.co';
  _auth_key text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRueXVrZ2ZlZHJlZHZ4cHpqcHF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2ODU1OTQsImV4cCI6MjA5MjI2MTU5NH0.OSg44w0CRVvD-f6Ts_U9DVeQkQ-4c37passKEK5X0kk';
  _payload jsonb;
BEGIN
  FOR _cmd IN
    SELECT c.id, c.equipment_id, e.name AS equipment_name, e.farm_id, f.name AS farm_name
    FROM commands c
    JOIN equipments e ON e.id = c.equipment_id
    JOIN farms f ON f.id = e.farm_id
    WHERE c.status = 'sent'
      AND c.type IN ('manual', 'automation')
      AND c.created_at < NOW() - INTERVAL '60 seconds'
      AND c.created_at > NOW() - INTERVAL '180 seconds'
  LOOP
    _payload := jsonb_build_object(
      'type', 'alert',
      'immediate', true,
      'source', 'db_cron_unresponsive',
      'farm_id', _cmd.farm_id,
      'equipment_id', _cmd.equipment_id,
      'equipment_name', _cmd.equipment_name,
      'farm_name', _cmd.farm_name,
      'origin', 'local',
      'message', '⚠️ ' || _cmd.equipment_name || ' não obedeceu ao comando — verificar se está Local'
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

    UPDATE commands SET status = 'timeout' WHERE id = _cmd.id;
  END LOOP;
END;
$$;

-- Reagenda o cron (remove agendamento antigo se existir)
DO $$
BEGIN
  PERFORM cron.unschedule('check-unresponsive-commands');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

SELECT cron.schedule('check-unresponsive-commands', '* * * * *', 'SELECT public.check_unresponsive_commands()');