-- Desligamento programado: robustez da atribuição no Relatório de Automação.
-- 1) Amplia a janela do trigger de 3 → 6 min (a telemetria pode chegar atrasada em
--    Starlink / durante a sequência de retentativas do scheduled-shutdown).
-- 2) Backfill dos registros de HOJE (11/08/2026) do desligamento 17h da Semear que
--    foram gravados como 'local'/Sistema por causa do cache defasado de
--    forced_shutdown_enabled no agente (corrigido no agente v3.25.63).
--    OBS: a tabela do relatório é automation_log (origin=event_origin, actor_label),
--    NÃO "equipment_logs"; o valor correto de origem é 'auto' (não 'scheduled').

CREATE OR REPLACE FUNCTION public.attribute_scheduled_shutdown_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rule text;
BEGIN
  IF NEW.equipment_id IS NULL THEN RETURN NEW; END IF;
  IF COALESCE(NEW.source_device, '') <> 'serial-bridge' THEN RETURN NEW; END IF;
  IF NEW.action NOT IN ('pump_on'::public.event_action, 'pump_off'::public.event_action,
                        'turn_on'::public.event_action, 'turn_off'::public.event_action) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.commands c
    WHERE c.equipment_id = NEW.equipment_id
      AND c.source_device LIKE 'backend-reset:scheduled_shutdown%'
      AND c.created_at > now() - interval '6 minutes'   -- era 3 min
  ) THEN
    SELECT NULLIF(btrim(last_changed_by), '') INTO v_rule
      FROM public.equipments WHERE id = NEW.equipment_id;
    NEW.origin := 'auto'::public.event_origin;
    NEW.actor_label := COALESCE(v_rule, 'Desligamento Programado');
    NEW.details := COALESCE(NEW.details, '{}'::jsonb) || jsonb_build_object('scheduled_shutdown', true);
  END IF;

  RETURN NEW;
END;
$function$;

-- (o trigger já existe apontando para esta função; CREATE OR REPLACE basta)

-- Backfill dos registros de HOJE (17h Semear) gravados como local/Sistema.
UPDATE public.automation_log
   SET origin = 'auto'::public.event_origin,
       actor_label = 'Desligamento 17h Semear'
 WHERE farm_id = (SELECT id FROM public.farms WHERE name ILIKE '%semear%' LIMIT 1)
   AND created_at::date = DATE '2026-08-11'
   AND action IN ('pump_off'::public.event_action, 'turn_off'::public.event_action)
   AND origin = 'local'::public.event_origin
   AND EXTRACT(HOUR FROM created_at AT TIME ZONE 'America/Bahia') = 17;
