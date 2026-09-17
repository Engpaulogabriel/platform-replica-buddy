DROP TRIGGER IF EXISTS trg_log_manual_command ON commands;

CREATE TRIGGER trg_log_manual_command
  AFTER UPDATE ON commands
  FOR EACH ROW
  WHEN (NEW.status IN ('executed', 'timeout', 'error') AND OLD.status IN ('pending', 'sent'))
  EXECUTE FUNCTION log_manual_command_to_automation_log();

UPDATE automation_log al
SET user_id = c.created_by,
    actor_label = COALESCE(
      (SELECT full_name FROM profiles WHERE id = c.created_by),
      (SELECT email FROM profiles WHERE id = c.created_by),
      'Usuário'
    )
FROM commands c
WHERE al.origin = 'remote'
  AND al.user_id IS NULL
  AND c.equipment_id = al.equipment_id
  AND c.created_at BETWEEN al.occurred_at - interval '2 minutes' AND al.occurred_at + interval '2 minutes'
  AND c.status IN ('executed', 'timeout', 'error', 'cancelled', 'sent');