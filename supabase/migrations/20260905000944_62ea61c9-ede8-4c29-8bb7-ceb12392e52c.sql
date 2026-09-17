-- lovable-cron-fallback-reviewed: 1440 runs/day; existing Automatic Mode engine trigger (pump schedules must be evaluated every minute); only repointing its auth to cron_invoke(), no new job
DO $$
DECLARE v_id bigint;
BEGIN
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = 'automation-tick-minute';
  IF v_id IS NOT NULL THEN
    PERFORM cron.alter_job(v_id, command := $cmd$SELECT public.cron_invoke('automation-tick', jsonb_build_object('time', now()));$cmd$);
  ELSE
    PERFORM cron.schedule('automation-tick-minute', '* * * * *', $cmd$SELECT public.cron_invoke('automation-tick', jsonb_build_object('time', now()));$cmd$);
  END IF;
END $$;