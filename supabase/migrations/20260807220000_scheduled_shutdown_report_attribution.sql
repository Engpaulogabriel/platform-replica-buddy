-- Atribuição correta do desligamento programado no Relatório de Automação ────
-- Problema: o relatório (tabela automation_log) mostrava "Via: Local / Por: Sistema"
-- para desligamentos disparados pela edge function scheduled-shutdown. A linha
-- exibida é a de TELEMETRIA (source_device='serial-bridge') gravada por
-- apply_pump_telemetry, que classifica a origem como 'local'/'system' e não sabe
-- que a causa foi a automação.
--
-- Correção (aditiva, SEM tocar apply_pump_telemetry): um trigger BEFORE INSERT em
-- automation_log reatribui SÓ essa linha de telemetria para origin='auto' + o nome
-- da regra (equipments.last_changed_by, gravado pelo edge), QUANDO há um comando de
-- desligamento programado recente (commands.source_device LIKE 'backend-reset:scheduled_shutdown%')
-- para a mesma bomba. Não toca em linhas de comando (backend-reset:*) nem em eventos
-- manuais/web/whatsapp. Janela curta (3 min) para não rotular ações manuais futuras.

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
  -- só a linha de telemetria de liga/desliga (não a linha do comando backend-reset:*)
  IF COALESCE(NEW.source_device, '') <> 'serial-bridge' THEN RETURN NEW; END IF;
  IF NEW.action NOT IN ('pump_on'::public.event_action, 'pump_off'::public.event_action,
                        'turn_on'::public.event_action, 'turn_off'::public.event_action) THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.commands c
    WHERE c.equipment_id = NEW.equipment_id
      AND c.source_device LIKE 'backend-reset:scheduled_shutdown%'
      AND c.created_at > now() - interval '3 minutes'
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

DROP TRIGGER IF EXISTS trg_attribute_scheduled_shutdown ON public.automation_log;
CREATE TRIGGER trg_attribute_scheduled_shutdown
  BEFORE INSERT ON public.automation_log
  FOR EACH ROW EXECUTE FUNCTION public.attribute_scheduled_shutdown_log();

COMMENT ON FUNCTION public.attribute_scheduled_shutdown_log() IS
  'BEFORE INSERT em automation_log: reatribui a linha de telemetria de um '
  'desligamento programado (scheduled-shutdown) para origin=auto + nome da regra. '
  'Corrige "Via: Local / Por: Sistema" no Relatório de Automação.';
