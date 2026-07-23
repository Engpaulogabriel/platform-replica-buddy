
-- Detecta comandos manuais/automation não obedecidos após 60s e marca o
-- equipamento como origem 'local' (chave física). Rodada por pg_cron a cada 30s.

CREATE OR REPLACE FUNCTION public.mark_disobeyed_commands_as_local()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  affected integer := 0;
BEGIN
  WITH candidates AS (
    SELECT DISTINCT e.id
    FROM public.equipments e
    JOIN public.commands c
      ON c.equipment_id = e.id
     AND c.type IN ('manual','automation')
     AND c.created_at >= now() - interval '120 seconds'
     AND c.created_at <= now() - interval '60 seconds'
    WHERE e.desired_running IS DISTINCT FROM e.last_confirmed_state
      AND (e.last_actuation_origin IS NULL OR e.last_actuation_origin <> 'local')
  )
  UPDATE public.equipments e
     SET last_actuation_origin = 'local',
         updated_at = now()
    FROM candidates
   WHERE e.id = candidates.id;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

GRANT EXECUTE ON FUNCTION public.mark_disobeyed_commands_as_local() TO service_role;

-- Agenda a checagem a cada 30 segundos
DO $$
BEGIN
  PERFORM cron.unschedule('mark-disobeyed-as-local');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'mark-disobeyed-as-local',
  '30 seconds',
  $$SELECT public.mark_disobeyed_commands_as_local();$$
);
