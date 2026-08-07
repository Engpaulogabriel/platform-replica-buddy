-- Correção pontual do histórico: desligamento programado da Semear em 2026-08-07 ─
-- Antes do trigger attribute_scheduled_shutdown_log entrar em vigor, as linhas do
-- desligamento das 17h ficaram como origin='local'/'system' + actor "Sistema".
-- Reatribui SÓ as linhas de telemetria (serial-bridge) de liga/desliga da Semear
-- na janela do desligamento (20:00–20:25 UTC = 17:00–17:25 BRT) para
-- origin='auto' + actor_label='Automação 17h'.
-- Idempotente: após rodar, as linhas já são 'auto' e não voltam a casar o filtro.

UPDATE public.automation_log
SET origin = 'auto'::public.event_origin,
    actor_label = 'Automação 17h',
    details = COALESCE(details, '{}'::jsonb) || jsonb_build_object('scheduled_shutdown', true, 'backfilled', true)
WHERE farm_id = (SELECT id FROM public.farms WHERE name ILIKE '%semear%' ORDER BY created_at LIMIT 1)
  AND occurred_at >= '2026-08-07 20:00:00+00'
  AND occurred_at <  '2026-08-07 20:25:00+00'
  AND COALESCE(source_device, '') = 'serial-bridge'
  AND action IN ('pump_on'::public.event_action, 'pump_off'::public.event_action,
                 'turn_on'::public.event_action, 'turn_off'::public.event_action)
  AND origin IN ('local'::public.event_origin, 'system'::public.event_origin);
