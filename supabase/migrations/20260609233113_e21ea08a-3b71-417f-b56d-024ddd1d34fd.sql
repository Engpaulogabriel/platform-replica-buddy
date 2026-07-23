UPDATE public.automation_log
SET actor_label = 'Sistema'
WHERE actor_label = 'Acionamento Local'
  AND user_id IS NULL
  AND (
    origin = 'system'::public.event_origin
    OR source_device IN ('agent-restart', 'ota-update', 'agent-polling', 'agent-safety', 'agent')
  );