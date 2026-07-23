DO $$
DECLARE
  _farm RECORD;
  _supabase_url text := 'https://dnyukgfedredvxpzjpqz.supabase.co';
  _auth_key text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRueXVrZ2ZlZHJlZHZ4cHpqcHF6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2ODU1OTQsImV4cCI6MjA5MjI2MTU5NH0.OSg44w0CRVvD-f6Ts_U9DVeQkQ-4c37passKEK5X0kk';
  _payload jsonb;
BEGIN
  FOR _farm IN SELECT id, name FROM public.farms
  LOOP
    _payload := jsonb_build_object(
      'type', 'alert',
      'immediate', true,
      'source', 'db_manual_recovery',
      'farm_id', _farm.id,
      'equipment_name', 'Sistema',
      'farm_name', _farm.name,
      'message', '✅ Comunicação restabelecida — ' || _farm.name || '. Sistema operando normalmente. Desculpe o transtorno.'
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
END $$;