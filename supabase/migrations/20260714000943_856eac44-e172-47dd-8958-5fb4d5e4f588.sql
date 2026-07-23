
-- 1) Desagenda o cron atual (se existir) para parar o spam imediatamente
DO $$
BEGIN
  PERFORM cron.unschedule('check-unresponsive-commands');
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- 2) Recria a função com UPDATE ... RETURNING atômico
CREATE OR REPLACE FUNCTION public.check_unresponsive_commands()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _cmd RECORD;
  _supabase_url text := 'https://dnyukgfedredvxpzjpqz.supabase.co';
  _auth_key text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRueXVrZ2ZlZHJlZHZ4cHpqcHF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2ODU1OTQsImV4cCI6MjA5MjI2MTU5NH0.OSg44w0CRVvD-f6Ts_U9DVeQkQ-4c37passKEK5X0kk';
  _payload jsonb;
BEGIN
  FOR _cmd IN
    WITH picked AS (
      SELECT c.id
      FROM commands c
      WHERE c.status = 'sent'
        AND c.type IN ('manual', 'automation')
        AND c.created_at < NOW() - INTERVAL '90 seconds'
        AND c.created_at > NOW() - INTERVAL '300 seconds'
      FOR UPDATE SKIP LOCKED
    )
    UPDATE commands c
       SET status = 'timeout'
      FROM picked
     WHERE c.id = picked.id
    RETURNING
      c.id,
      c.equipment_id,
      (SELECT e.name    FROM equipments e WHERE e.id = c.equipment_id) AS equipment_name,
      (SELECT e.farm_id FROM equipments e WHERE e.id = c.equipment_id) AS farm_id,
      (SELECT f.name    FROM farms f
        WHERE f.id = (SELECT e.farm_id FROM equipments e WHERE e.id = c.equipment_id)) AS farm_name
  LOOP
    _payload := jsonb_build_object(
      'type', 'alert',
      'immediate', true,
      'source', 'db_cron_unresponsive',
      'farm_id', _cmd.farm_id,
      'equipment_id', _cmd.equipment_id,
      'equipment_name', _cmd.equipment_name,
      'farm_name', _cmd.farm_name,
      'origin', 'timeout',
      'message', '⚠️ ' || COALESCE(_cmd.equipment_name, 'Equipamento') ||
                 ' não confirmou comando em 90s — verificar comunicação'
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
  END LOOP;
END;
$$;

-- 3) Reagenda o cron a cada 1 minuto
SELECT cron.schedule(
  'check-unresponsive-commands',
  '* * * * *',
  $$SELECT public.check_unresponsive_commands()$$
);
