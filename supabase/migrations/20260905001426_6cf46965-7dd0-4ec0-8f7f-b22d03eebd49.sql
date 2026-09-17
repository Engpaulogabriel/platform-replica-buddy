CREATE OR REPLACE FUNCTION public.automatic_desired_state(_time_on text, _time_off text, _days text[], _mode text, _now_min integer, _dow_today text, _dow_prev text)
 RETURNS text
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
DECLARE
  v_on  int;
  v_off int;
  v_hoje boolean;
  v_ontem boolean;
  -- Dias podem estar em PT (seg/ter/...) ou EN (mon/tue/...). Normaliza os
  -- dois lados para EN antes de comparar — o tick passa sempre EN.
  v_days text[];
BEGIN
  SELECT COALESCE(array_agg(CASE lower(d)
           WHEN 'dom' THEN 'sun' WHEN 'seg' THEN 'mon' WHEN 'ter' THEN 'tue'
           WHEN 'qua' THEN 'wed' WHEN 'qui' THEN 'thu' WHEN 'sex' THEN 'fri'
           WHEN 'sab' THEN 'sat' WHEN 'sáb' THEN 'sat' ELSE lower(d) END), '{}')
    INTO v_days FROM unnest(COALESCE(_days, '{}')) AS d;

  IF _time_on  ~ '^\d{2}:\d{2}' THEN
    v_on := (split_part(_time_on,':',1))::int * 60 + (split_part(_time_on,':',2))::int;
  END IF;
  IF _time_off ~ '^\d{2}:\d{2}' THEN
    v_off := (split_part(_time_off,':',1))::int * 60 + (split_part(_time_off,':',2))::int;
  END IF;

  v_hoje  := lower(_dow_today) = ANY(v_days);
  v_ontem := lower(_dow_prev)  = ANY(v_days);

  IF v_on IS NULL THEN
    IF v_off IS NOT NULL AND v_hoje AND _now_min >= v_off THEN RETURN 'off'; END IF;
    RETURN NULL;
  END IF;

  IF v_off IS NULL THEN
    IF v_hoje AND _now_min >= v_on THEN RETURN 'on'; END IF;
    RETURN NULL;
  END IF;

  IF v_on < v_off THEN
    IF NOT v_hoje THEN RETURN NULL; END IF;
    IF _now_min >= v_on AND _now_min < v_off THEN RETURN 'on'; END IF;
    IF _now_min >= v_off THEN RETURN 'off'; END IF;
    RETURN NULL;
  ELSE
    IF v_hoje AND _now_min >= v_on THEN RETURN 'on'; END IF;
    IF v_ontem AND _now_min < v_off THEN RETURN 'on'; END IF;
    IF v_ontem AND _now_min >= v_off THEN RETURN 'off'; END IF;
    RETURN NULL;
  END IF;
END; $function$;