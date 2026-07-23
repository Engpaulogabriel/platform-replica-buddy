DO $$
DECLARE
  v_farm uuid;
  v_ids uuid[];
BEGIN
  SELECT id INTO v_farm FROM farms WHERE name ILIKE '%sossego%' LIMIT 1;
  SELECT COALESCE(array_agg(DISTINCT s), '{}')
    INTO v_ids
  FROM automation_guards g, unnest(g.silenced_schedule_ids) s
  WHERE g.farm_id = v_farm;

  IF array_length(v_ids,1) > 0 THEN
    UPDATE automation_schedules SET active = true WHERE id = ANY(v_ids);
  END IF;

  DELETE FROM automation_guards WHERE farm_id = v_farm;
END $$;