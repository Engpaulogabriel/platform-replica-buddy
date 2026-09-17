UPDATE public.automation_log
SET result = 'success'
WHERE origin = 'remote' AND result = 'fail';