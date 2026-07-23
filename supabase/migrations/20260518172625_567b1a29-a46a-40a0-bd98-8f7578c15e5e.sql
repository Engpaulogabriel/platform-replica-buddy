ALTER TABLE public.automation_schedules REPLICA IDENTITY FULL;
ALTER TABLE public.automation_engine REPLICA IDENTITY FULL;
ALTER TABLE public.automation_holiday_configs REPLICA IDENTITY FULL;

ALTER PUBLICATION supabase_realtime ADD TABLE public.automation_schedules;
ALTER PUBLICATION supabase_realtime ADD TABLE public.automation_engine;
ALTER PUBLICATION supabase_realtime ADD TABLE public.automation_holiday_configs;