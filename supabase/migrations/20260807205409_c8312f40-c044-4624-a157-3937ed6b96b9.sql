-- 20260807230000_fix_semear_17h_history.sql
-- Backfill: reatribui os desligamentos do dia 2026-08-07 (17:00-17:20 BRT)
-- da fazenda Semear para a automação "Desligamento 17h Semear".
UPDATE public.automation_log al
SET origin = 'auto'::event_origin,
    actor_label = 'Desligamento 17h Semear',
    details = COALESCE(al.details, '{}'::jsonb)
              || jsonb_build_object('scheduled_automation', 'Desligamento 17h Semear',
                                    'backfilled', true)
WHERE al.farm_id = '0b1d53df-6d5c-4674-8517-9299aac3ec18'
  AND al.action = 'turn_off'::event_action
  AND al.occurred_at >= '2026-08-07 20:00:00+00'
  AND al.occurred_at <  '2026-08-07 20:21:00+00'
  AND al.origin = 'local'::event_origin
  AND al.user_id IS NULL;