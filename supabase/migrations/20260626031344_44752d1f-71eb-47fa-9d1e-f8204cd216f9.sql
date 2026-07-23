DROP TRIGGER IF EXISTS automation_engine_mode_notify ON public.automation_engine;

DROP TRIGGER IF EXISTS automation_schedule_mode_notify_insert ON public.automation_schedules;
DROP TRIGGER IF EXISTS automation_schedule_mode_notify_update ON public.automation_schedules;
DROP TRIGGER IF EXISTS automation_schedule_mode_notify ON public.automation_schedules;
DROP TRIGGER IF EXISTS automation_schedules_mode_notify ON public.automation_schedules;

DROP FUNCTION IF EXISTS public.notify_engine_mode_change();
DROP FUNCTION IF EXISTS public.notify_schedule_mode_change();

UPDATE public.pending_notifications
SET processed = true,
    processed_at = now()
WHERE processed = false
  AND change_type IN ('engine_mode', 'schedule_mode');