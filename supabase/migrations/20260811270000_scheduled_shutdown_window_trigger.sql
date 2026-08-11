-- Atribuição do desligamento programado no relatório — INDEPENDENTE do agente.
-- ─────────────────────────────────────────────────────────────────────────────
-- Estende o trigger BEFORE INSERT em automation_log (trg_attribute_scheduled_shutdown)
-- com um 2º caminho por JANELA DE HORÁRIO (config-driven, sem hardcode de fazenda):
--   Se a linha é um DESLIGAMENTO (off) marcado como 'local'/'system' e cai dentro
--   da janela de execução de uma regra ATIVA em scheduled_automations da MESMA
--   fazenda — [horário-5min, horário + max_retries*retry_interval + 5min],
--   respeitando days_of_week (BRT) — reatribui para origin='auto' + o NOME da regra.
-- Assim, mesmo um agente ANTIGO que grava origin='local' é corrigido na inserção;
-- não depende de OTA/versão. Para a regra 17h (3×5min) a janela é 16:55–17:20 BRT.
CREATE OR REPLACE FUNCTION public.attribute_scheduled_shutdown_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rule    text;
  v_brt     timestamp;
  v_now_min int;
  v_dow     text;
BEGIN
  IF NEW.equipment_id IS NULL THEN RETURN NEW; END IF;
  IF NEW.action NOT IN ('pump_on'::public.event_action, 'pump_off'::public.event_action,
                        'turn_on'::public.event_action, 'turn_off'::public.event_action) THEN
    RETURN NEW;
  END IF;

  -- (A) Caminho já existente: comando scheduled_shutdown recente (linha de telemetria).
  IF COALESCE(NEW.source_device, '') = 'serial-bridge' AND EXISTS (
    SELECT 1 FROM public.commands c
    WHERE c.equipment_id = NEW.equipment_id
      AND c.source_device LIKE 'backend-reset:scheduled_shutdown%'
      AND c.created_at > now() - interval '6 minutes'
  ) THEN
    SELECT NULLIF(btrim(last_changed_by), '') INTO v_rule
      FROM public.equipments WHERE id = NEW.equipment_id;
    NEW.origin := 'auto'::public.event_origin;
    NEW.actor_label := COALESCE(v_rule, 'Desligamento Programado');
    NEW.details := COALESCE(NEW.details, '{}'::jsonb) || jsonb_build_object('scheduled_shutdown', true);
    RETURN NEW;
  END IF;

  -- (B) Fallback por JANELA de scheduled_automations — só DESLIGAMENTO local/system.
  IF NEW.action IN ('pump_off'::public.event_action, 'turn_off'::public.event_action)
     AND NEW.origin IN ('local'::public.event_origin, 'system'::public.event_origin) THEN
    v_brt := (now() AT TIME ZONE 'America/Bahia');
    v_now_min := (extract(hour from v_brt)::int) * 60 + (extract(minute from v_brt)::int);
    v_dow := (ARRAY['sun','mon','tue','wed','thu','fri','sat'])[(extract(dow from v_brt)::int) + 1];

    SELECT sa.name INTO v_rule
    FROM public.scheduled_automations sa
    WHERE sa.farm_id = NEW.farm_id
      AND sa.is_active = true
      AND sa.time_brt ~ '^[0-9]{1,2}:[0-9]{2}'
      AND (sa.days_of_week IS NULL
           OR array_length(sa.days_of_week, 1) IS NULL
           OR v_dow = ANY(sa.days_of_week))
      AND v_now_min >= ((substring(sa.time_brt from '^([0-9]{1,2})')::int) * 60
                        + (substring(sa.time_brt from ':([0-9]{2})')::int)) - 5
      AND v_now_min <= ((substring(sa.time_brt from '^([0-9]{1,2})')::int) * 60
                        + (substring(sa.time_brt from ':([0-9]{2})')::int))
                        + (COALESCE(sa.max_retries, 3) * COALESCE(sa.retry_interval_min, 5)) + 5
    ORDER BY sa.time_brt
    LIMIT 1;

    IF v_rule IS NOT NULL THEN
      NEW.origin := 'auto'::public.event_origin;
      NEW.actor_label := v_rule;   -- ex.: "Desligamento 17h Semear"
      NEW.details := COALESCE(NEW.details, '{}'::jsonb)
                     || jsonb_build_object('scheduled_shutdown', true, 'via', 'time_window');
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

-- O trigger trg_attribute_scheduled_shutdown já aponta para esta função (BEFORE
-- INSERT em automation_log); CREATE OR REPLACE basta. Recria por segurança:
DROP TRIGGER IF EXISTS trg_attribute_scheduled_shutdown ON public.automation_log;
CREATE TRIGGER trg_attribute_scheduled_shutdown
  BEFORE INSERT ON public.automation_log
  FOR EACH ROW EXECUTE FUNCTION public.attribute_scheduled_shutdown_log();
